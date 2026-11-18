/**
 * dsh-purge-mode — 原生 / purge 双模切换，**按会话独立**。
 *
 * 与 1.0.0（全局开关）的区别
 * --------------------------
 * 1.0.0 只维护一个全局 mode，`syncTarget` 直接把它写进 dsh-purge 的 fiber.config，
 * 于是 A 会话切原生、B 会话也跟着变。本版把状态改为「每会话一份」：
 *
 *   state.json
 *   {
 *     "defaultMode": "native",                       // 新会话默认（= 关闭 purge）
 *     "sessions": { "<session-id>": { "mode": "purge", "updatedAt": "..." } }
 *   }
 *
 * 注入路径与 1.0.0 完全一致，仍然不改 dsh-purge 一行源码，只原地翻转
 * dsh-purge 的同一个 config 对象：
 *
 *   enabled            → operator inject / boost / probe / postPrompt
 *   capabilityProtocol → purge 版「能力选用协议」
 *   stripMnemon        → 是否丢弃宿主自己的 agent-instructions 段
 *
 * 关键：dsh-purge 在 `system-prompt/assemble` 上是 **prepend** 注册，它先拿到
 * waterfall，`await next()` 之后才读 config 做重写。本插件用 **非 prepend**
 * 注册，因此排在它下游 —— 我们在自己的 handler 里按「本次装配所属会话」写好
 * config，purge 随后读到的就是这一份。同一轮里只会有一个会话在装配，所以
 * 不需要加锁，也不需要复原：下一轮会被重新写入。
 *
 * 子代理：header.origin === "subagent" 时沿 parentSession 上溯到根会话，
 * 继承根会话的选择（子代理不会在任务中途突然变回原生提示词）。
 *
 * ## 对话隔离（v2.1）
 *
 * config 是单例、assemble 是异步，所以「写 config 再让它读」在并发装配时会串味：
 * purge 的 assembleGuard 在 `await orig()` **之后**才读 config，那时另一个会话
 * 可能已经把 config 改掉了。v2.1 改为**只读视图**：
 *
 *   - purge 的三个开关变成 getter，从 AsyncLocalStorage 取当前装配的模式；
 *   - 外层包住 `systemPrompt.assemble`，在进入 purge 的整条执行链**之前**建立
 *     会话作用域，因此事件路径与 guard 路径都在同一个作用域内求值。
 *
 * getter 在无装配上下文时回退到基准值，启动期与其它非装配路径行为不变。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

export const name = "dsh-purge-mode";

/** 等待的宿主服务。 */
export const inject = ["webServer", "systemPrompt"];

/** 目标插件在 Loader 里的行 id / 包名。 */
const TARGET_ENTRY_IDS = new Set(["dsh-purge"]);
const TARGET_ENTRY_NAMES = new Set(["dsh-purge-community"]);

const MODE_PURGE = "purge";
const MODE_NATIVE = "native";
const MODES = new Set([MODE_PURGE, MODE_NATIVE]);
/** 新会话默认：关闭 purge（与用户选择一致）。 */
const DEFAULT_MODE = MODE_NATIVE;

const STATE_DIR = "dsh-purge-mode";
const STATE_FILE = "state.json";

/**
 * native 模式补回被 bundle 补丁清掉的官方身份句。
 * 段名以 `dsh-purge` 开头是刻意的：purge 的重写器只对「插件段」跳过身份剥离。
 */
const PERSONA_SECTION = "dsh-purge-mode:persona";
const PERSONA_ORDER = 0;
const NATIVE_PERSONA = "You are a coding agent powered by the {{model}} model.";

/* ------------------------------------------------------------------ 状态文件 */

function homeDir() {
  const fromEnv = String(process.env.DSH_HOME || "").trim();
  return fromEnv || path.join(os.homedir(), ".dsh");
}

function statePath() {
  return path.join(homeDir(), STATE_DIR, STATE_FILE);
}

function normalizeState(raw) {
  const parsed = raw !== null && typeof raw === "object" ? raw : {};
  const sessions = {};
  const input = parsed.sessions !== null && typeof parsed.sessions === "object" ? parsed.sessions : {};
  for (const [id, value] of Object.entries(input)) {
    const mode = String(value?.mode ?? "").trim().toLowerCase();
    if (!id || !MODES.has(mode)) continue;
    sessions[String(id)] = {
      mode,
      updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : "",
    };
  }
  const defaultMode = MODES.has(String(parsed.defaultMode ?? "").trim().toLowerCase())
    ? String(parsed.defaultMode).trim().toLowerCase()
    : "";
  return { defaultMode, sessions };
}

function readState() {
  let state;
  try {
    state = normalizeState(JSON.parse(fs.readFileSync(statePath(), "utf8")));
  } catch {
    state = { defaultMode: "", sessions: {} };
  }
  if (!state.defaultMode) state.defaultMode = DEFAULT_MODE;
  return state;
}

function writeState(next) {
  const file = statePath();
  const normalized = normalizeState(next);
  if (!normalized.defaultMode) normalized.defaultMode = DEFAULT_MODE;
  const payload = {
    defaultMode: normalized.defaultMode,
    sessions: normalized.sessions,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
  return payload;
}

/* ------------------------------------------------------------ 会话 → 模式 */

function sessionOf(context) {
  return context?.agent?.session || context?.session || null;
}

function headerIdOf(session) {
  const header = session?.header ?? {};
  const id = header.id ?? session?.id ?? session?.sessionId;
  return typeof id === "string" ? id.trim() : String(id ?? "").trim();
}

/**
 * 取 sessions 服务。不走 ctx.sessions 属性访问：未写进 inject 时 Cordis 代理会抛，
 * 而把 sessions 写进 inject 又会在没有该服务的宿主上空等（插件 pending → 宿主退出码 1）。
 */
function sessionsService(ctx) {
  try {
    const viaGet = ctx?.get?.("sessions", false);
    if (viaGet) return viaGet;
  } catch {
    /* 没有该服务 */
  }
  return null;
}

/** 从 sessions 服务里按 id 找会话记录（子代理上溯时用）。 */
function lookupSession(ctx, id) {
  const wanted = String(id ?? "").trim();
  if (!wanted) return undefined;
  const service = sessionsService(ctx);
  if (!service) return undefined;
  let list = [];
  try {
    list = service.list?.() ?? [];
  } catch {
    list = [];
  }
  for (const item of list ?? []) {
    if (headerIdOf(item) === wanted) return item;
  }
  try {
    const direct = service.get?.(wanted);
    if (direct) return direct;
  } catch {
    /* 没有 get */
  }
  return undefined;
}

/**
 * 解析本次装配应当使用哪个会话的模式。
 * 子代理沿 parentSession 上溯到根会话，继承根会话的选择。
 * @param ctx - Cordis 插件上下文。
 * @param context - assemble 传入的装配上下文。
 * @returns {{sessionId: string, rootId: string}}
 */
function resolveSessionChain(ctx, context) {
  const origin = sessionOf(context);
  let session = origin;
  const seen = new Set();
  while (session) {
    const id = headerIdOf(session);
    if (!id || seen.has(id)) break;
    seen.add(id);
    const header = session.header ?? {};
    const isSub = header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
    const parentId = String(header.parentSession ?? "").trim();
    if (!isSub || !parentId) break;
    const parent = lookupSession(ctx, parentId);
    if (!parent) break;
    session = parent;
  }
  const rootId = headerIdOf(session) || headerIdOf(origin);
  return { sessionId: headerIdOf(origin), rootId };
}

/** 某个根会话应当用的模式：显式选择 > 全局默认。 */
function modeForSession(state, rootId) {
  const entry = rootId ? state.sessions[rootId] : undefined;
  if (entry && MODES.has(entry.mode)) return { mode: entry.mode, source: "session" };
  return { mode: state.defaultMode || DEFAULT_MODE, source: "default" };
}

/* ------------------------------------------------------------ 目标插件配置 */

/** dsh-purge 用全局 Symbol 挂 assembleGuard，据此也能拿到它的 slot。 */
const ASSEMBLE_GUARD = Symbol.for("dsh-purge.assembleGuard");

/**
 * 装配期间「当前会话模式」的载体。
 *
 * 为什么必须用它：dsh-purge 的 `fiber.config` 是**单例**，而 assemble 是异步的。
 * 若在装配前把 config 写成某个会话的值，两个会话并发装配时后写的会覆盖先写的，
 * 于是 A 会话会读到 B 的模式 —— 这正是「对话之间互相影响」。用 AsyncLocalStorage
 * 把模式挂在**异步调用链**上，再让 config 的读取走 getter，同一时刻两个装配各自
 * 读到自己那份，互不干扰。
 */
const modeStore = new AsyncLocalStorage();

/** 每个 config 对象一份「无装配上下文时的基准值」。 */
const configBases = new WeakMap();

function targetFiber(ctx) {
  const entries = ctx?.loader?.entries?.() ?? [];
  for (const entry of entries) {
    const options = entry?.options ?? {};
    const id = String(options.id ?? "");
    const entryName = String(options.name ?? "");
    if (!TARGET_ENTRY_IDS.has(id) && !TARGET_ENTRY_NAMES.has(entryName)) continue;
    const fiber = entry.fiber;
    if (!fiber) continue;
    if (fiber.state !== undefined && fiber.state !== 2) continue;
    return fiber;
  }
  return undefined;
}

/** 读 config 上某个字段的原始值（已装视图时读基准值）。 */
function baseValueOf(config, key) {
  const base = configBases.get(config);
  if (base) return base[key];
  try {
    const value = config[key];
    return value !== false;
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------ 目标插件配置 */

/**
 * 把 config 的三个开关换成**按装配上下文求值**的 getter。
 *
 * purge 只读不写这三个字段（`config.enabled !== false` 这类判断），所以换成
 * getter 对它是透明的；而 getter 在无装配上下文时回退到基准值，保证
 * 启动期 / 非装配路径的行为与纯 purge 一致。
 *
 * @param ctx - Cordis 插件上下文。
 * @param fallbackMode - 无装配上下文时使用的模式（= 全局默认）。
 * @returns {boolean} 是否就绪
 */
function installConfigView(ctx, fallbackMode) {
  const fiber = targetFiber(ctx);
  const config = fiber?.config;
  if (!config || typeof config !== "object") return false;
  if (configBases.has(config)) return true;

  const native = fallbackMode === MODE_NATIVE;
  const base = {
    enabled: !native,
    capabilityProtocol: !native,
    stripMnemon: !native,
  };
  configBases.set(config, base);

  for (const key of ["enabled", "capabilityProtocol", "stripMnemon"]) {
    try {
      Object.defineProperty(config, key, {
        configurable: true,
        enumerable: true,
        get() {
          const mode = modeStore.getStore();
          // 无装配上下文：用基准值（启动期 / 非装配路径）。
          if (mode === undefined) return base[key];
          // purge 模式三项全开；native 三项全关。
          return mode === MODE_PURGE;
        },
        set(value) {
          base[key] = value !== false;
        },
      });
    } catch {
      return false;
    }
  }
  return true;
}

/** 更新基准值（改默认值时用，影响非装配路径与新进程首轮）。 */
function setConfigBase(ctx, mode) {
  const fiber = targetFiber(ctx);
  const config = fiber?.config;
  if (!config) return false;
  const base = configBases.get(config);
  if (!base) return false;
  const native = mode === MODE_NATIVE;
  base.enabled = !native;
  base.capabilityProtocol = !native;
  base.stripMnemon = !native;
  return true;
}

function describeTarget(ctx) {
  const fiber = targetFiber(ctx);
  if (!fiber) return { found: false };
  const config = fiber.config ?? {};
  const view = configBases.has(config);
  return {
    found: true,
    // 有视图时报告基准值；具体会话的模式看 mode 字段。
    enabled: view ? baseValueOf(config, "enabled") : config.enabled !== false,
    capabilityProtocol: view ? baseValueOf(config, "capabilityProtocol") : config.capabilityProtocol !== false,
    stripMnemon: view ? baseValueOf(config, "stripMnemon") : config.stripMnemon !== false,
    view,
  };
}

/* ------------------------------------------------------------------ 权限切换 */

/** 每种模式对应的官方权限预设（sandbox + approval）。 */
const PERMISSION_PRESETS = {
  [MODE_NATIVE]: { sandbox: "workspace-write", approval: "ask" },
  [MODE_PURGE]: { sandbox: "danger-full-access", approval: "never" },
};

function sessionById(ctx, sessionId) {
  const wanted = String(sessionId ?? "").trim();
  if (!wanted) return undefined;
  return lookupSession(ctx, wanted);
}

/**
 * 用官方的每会话开关改权限：`sandbox/mode` 与 `approval/policy` 都是会话事件，
 * 读取时 override 优先于被 patch 过的默认值，因此免重启。
 */
async function applySessionPermission(ctx, session, mode) {
  const preset = PERMISSION_PRESETS[mode] ?? PERMISSION_PRESETS[MODE_NATIVE];
  if (!session) return { applied: false, reason: "session not found" };
  try {
    const [{ setApprovalPolicy }, { setSandboxMode }] = await Promise.all([
      import("@deepseek-ai/dsh-user-approval"),
      import("@deepseek-ai/dsh-sandbox-policy"),
    ]);
    setSandboxMode(session, preset.sandbox);
    setApprovalPolicy(session, preset.approval);
    return { applied: true, sandbox: preset.sandbox, approval: preset.approval };
  } catch (error) {
    return { applied: false, reason: String(error?.message ?? error) };
  }
}

/* ------------------------------------------------------------------ 提示词段 */

function registerPersonaSection(ctx, resolveMode) {
  const hosts = [];
  const push = (host) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  try {
    push(ctx?.systemPrompt?.ctx);
  } catch {
    /* 代理尚未注入 */
  }
  push(ctx);
  for (const host of hosts) {
    try {
      host.systemPrompt.section({
        name: PERSONA_SECTION,
        order: PERSONA_ORDER,
        text: (context) => (resolveMode(context) === MODE_NATIVE ? NATIVE_PERSONA : ""),
      });
    } catch {
      /* 段已注册或服务不可用 */
    }
  }
}

/* -------------------------------------------------------------------- HTTP */

function headerOf(request, name) {
  const headers = request?.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] ?? "");
  return typeof value === "string" ? value : "";
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function denyCrossOrigin(response) {
  sendJson(response, 403, { ok: false, error: "cross-origin blocked" });
}

function allowRequest(request, response) {
  const site = headerOf(request, "sec-fetch-site").toLowerCase();
  if (site === "cross-site") {
    denyCrossOrigin(response);
    return false;
  }
  const origin = headerOf(request, "origin").trim();
  if (origin === "null") {
    denyCrossOrigin(response);
    return false;
  }
  if (!origin) return true;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    denyCrossOrigin(response);
    return false;
  }
  const host = headerOf(request, "host").trim();
  if (!host || originHost.toLowerCase() !== host.toLowerCase()) {
    denyCrossOrigin(response);
    return false;
  }
  return true;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 把一个 sessionId 归一到「该读哪条记录」的根会话。
 * 子代理沿 parentSession 上溯，与装配期 `resolveSessionChain` 同一套语义，
 * 否则面板显示的和实际注入的会不一致。
 */
function rootIdOf(ctx, sessionId) {
  const id = String(sessionId ?? "").trim();
  if (!id) return "";
  const session = lookupSession(ctx, id);
  if (!session) return id;
  try {
    return resolveSessionChain(ctx, { agent: { session } }).rootId || id;
  } catch {
    return id;
  }
}

function statusPayload(ctx, sessionId, rootId) {
  const state = readState();
  const resolved = modeForSession(state, rootId);
  return {
    ok: true,
    sessionId: sessionId || "",
    rootId: rootId || "",
    mode: resolved.mode,
    modeSource: resolved.source,
    defaultMode: state.defaultMode,
    sessionCount: Object.keys(state.sessions).length,
    target: describeTarget(ctx),
    nextTurn: true,
  };
}

/* ------------------------------------------------------------------ 插件入口 */

/**
 * @param ctx - Cordis 插件上下文。
 */
export function apply(ctx) {
  /**
   * 装配期解析：只读状态，不写。
   * 每次 assemble 都重新读盘，是为了让「别的会话刚改过默认值」也能立刻体现。
   */
  const resolveMode = (context) => {
    let state;
    try {
      state = readState();
    } catch {
      state = { defaultMode: DEFAULT_MODE, sessions: {} };
    }
    let rootId = "";
    try {
      rootId = resolveSessionChain(ctx, context).rootId;
    } catch {
      rootId = "";
    }
    return modeForSession(state, rootId).mode;
  };

  registerPersonaSection(ctx, resolveMode);

  /**
   * 会话作用域内装配。
   *
   * 只要进入 purge 的执行链就带上「本会话模式」，config 的 getter 全程读得到。
   * 拿不到会话时（暖机、非会话装配）不建作用域，getter 回退基准值。
   */
  const runScoped = (context, fn) => {
    let mode;
    try {
      mode = resolveMode(context);
    } catch {
      mode = undefined;
    }
    if (mode === undefined) return fn();
    return modeStore.run(mode, fn);
  };

  /**
   * 主入口：包住 `systemPrompt.assemble`，让**整条 purge 执行链**（事件路径 +
   * assembleGuard 的二次重写）都落在同一个会话作用域里。
   *
   * 直接改 config 做不到这点：guard 在 `await orig()` 之后才读 config，那时
   * 另一会话可能已改写。作用域跟着异步调用链走，才能在并发下各自读到自己那份。
   */
  const hosts = [];
  const pushHost = (host) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  try {
    pushHost(ctx?.systemPrompt?.ctx);
  } catch {
    /* 代理未就绪 */
  }
  pushHost(ctx);

  /**
   * 尝试把 assemble 包进会话作用域。
   *
   * 只在 **dsh-purge 已安装 guard** 时接管：purge 的 accessor getter 上带着
   * `ASSEMBLE_GUARD` Symbol，我们复用同一个 Symbol，purge 的 400ms 重装就会走
   * `bindSlot`（只刷新 `slot.rewrite`）而不再替换 accessor。
   *
   * 反过来，如果 purge 还没装、我们抢先造一个 Symbol，purge 会认为 guard 已在
   * 而**跳过包装**，注入直接失效。所以没看到 Symbol 就原样返回，等心跳重试。
   *
   * @returns {boolean} 是否已接管
   */
  const scopeHost = (host) => {
    const prompt = host?.systemPrompt;
    if (!prompt) return false;
    if (prompt.__dshPurgeModeScoped) return true;
    const descriptor = Object.getOwnPropertyDescriptor(prompt, "assemble");
    if (!descriptor || typeof descriptor.get !== "function") return false;
    const innerGet = descriptor.get;
    const guardSlot = innerGet[ASSEMBLE_GUARD];
    // purge 尚未安装 guard：保持原样，绝不伪造 Symbol。
    if (!guardSlot) return false;

    const getter = function scopedAssembleGetter() {
      const inner = innerGet.call(this);
      if (typeof inner !== "function") return inner;
      return function scopedAssemble(...args) {
        return runScoped(args[0], () => inner.apply(this, args));
      };
    };
    getter[ASSEMBLE_GUARD] = guardSlot;
    try {
      Object.defineProperty(prompt, "assemble", {
        configurable: true,
        enumerable: descriptor.enumerable !== false,
        get: getter,
        set(next) {
          descriptor.set?.call(this, next);
        },
      });
      prompt.__dshPurgeModeScoped = true;
      return true;
    } catch {
      return false;
    }
  };

  const scopeAll = () => {
    let ok = 0;
    for (const host of hosts) {
      try {
        if (scopeHost(host)) ok += 1;
      } catch {
        /* 这一层代理包不上，心跳再试 */
      }
    }
    return ok;
  };
  scopeAll();

  /**
   * 兜底：事件路径单独再包一层。
   * 万一 assemble 包装没挂上（宿主换了访问方式），事件监听仍能建立作用域。
   */
  try {
    ctx.on(
      "system-prompt/assemble",
      async (...args) => {
        const [assembly, context] = args;
        const next = args.length >= 3 ? args[args.length - 1] : null;
        return runScoped(context, () => (typeof next === "function" ? next() : assembly));
      },
      { global: true, prepend: true },
    );
  } catch (error) {
    console.warn("[dsh-purge-mode] assemble hook failed:", String(error?.message ?? error));
  }

  /**
   * 心跳：同时维持两件事，两者都可能被 purge 的重装顶掉。
   *
   *   1. assemble 包装 —— purge 400ms 重装 accessor，只在它已带 Symbol 时接管；
   *   2. config 只读视图 —— purge 若晚于本插件 apply，`fiber.config` 那时还不存在。
   *
   * 已就绪时不再重复写属性，避免每拍都触发 defineProperty。
   */
  const tick = () => {
    try {
      scopeAll();
    } catch {
      /* 下一次再试 */
    }
    try {
      if (installConfigView(ctx, readState().defaultMode)) {
        setConfigBase(ctx, readState().defaultMode);
      }
    } catch {
      /* 目标未就绪 */
    }
  };
  tick();
  const armTimer = setInterval(tick, 500);
  if (typeof armTimer.unref === "function") armTimer.unref();
  try {
    ctx.effect(() => () => clearInterval(armTimer));
  } catch {
    /* 无 effect 时靠 scope 回收 */
  }

  // 新会话按当前默认值刷权限：dsh-purge 的 installFreshFullAccess 会在建会话时
  // 把权限钉成 danger-full-access（microtask），我们紧随其后改回默认方案。
  try {
    const disposer = ctx.on("session/created", (session) => {
      setTimeout(() => {
        const id = headerIdOf(session);
        const state = readState();
        const mode = modeForSession(state, id).mode;
        void applySessionPermission(ctx, session, mode);
      }, 0);
    });
    try {
      ctx.effect(() => () => disposer?.());
    } catch {
      /* 无 effect 时靠 cordis scope 回收 */
    }
  } catch {
    /* session/created 不可用 */
  }

  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      const dispose = host.webServer.register(
        {
          kind: "exact",
          path: "/dsh-purge-mode/mode",
          handler: async (request, response) => {
            if (!allowRequest(request, response)) return;
            try {
              const method = String(request.method ?? "GET").toUpperCase();
              const url = new URL(request.url ?? "/", "http://127.0.0.1");

              if (method === "GET") {
                const sessionId = String(url.searchParams.get("sessionId") ?? "").trim();
                // 子代理上溯到根会话，与装配期口径一致。
                const rootId = rootIdOf(ctx, sessionId);
                sendJson(response, 200, statusPayload(ctx, sessionId, rootId));
                return;
              }
              if (method !== "POST") {
                response.writeHead(405, { allow: "GET, POST" });
                response.end();
                return;
              }

              const body = await readJsonBody(request);
              const state = readState();
              const sessionId = String(body?.sessionId ?? "").trim();
              const scope = String(body?.scope ?? "").trim().toLowerCase();
              const rawMode = body?.mode === null ? null : String(body?.mode ?? "").trim().toLowerCase();

              if (rawMode !== null && rawMode !== "" && !MODES.has(rawMode)) {
                sendJson(response, 400, { ok: false, error: `unknown mode "${rawMode}"` });
                return;
              }

              const now = new Date().toISOString();

              // 批量：把所有会话 + 默认值一起设。
              if (scope === "all") {
                const next = { defaultMode: rawMode || DEFAULT_MODE, sessions: {} };
                if (rawMode) {
                  for (const id of Object.keys(state.sessions)) {
                    next.sessions[id] = { mode: rawMode, updatedAt: now };
                  }
                }
                writeState(next);
                // 已存在的会话逐个刷权限；新会话在 session/created 时跟随默认值。
                const touched = [];
                for (const id of Object.keys(state.sessions)) {
                  const session = sessionById(ctx, id);
                  if (!session) continue;
                  const r = await applySessionPermission(ctx, session, next.defaultMode);
                  if (r.applied) touched.push(id);
                }
                sendJson(response, 200, {
                  ...statusPayload(ctx, "", ""),
                  scope: "all",
                  sessionsUpdated: touched.length,
                });
                return;
              }

              // 清除某会话记忆：回到默认。
              if (rawMode === null || rawMode === "") {
                if (!sessionId) {
                  sendJson(response, 400, { ok: false, error: "sessionId or scope required" });
                  return;
                }
                const key = rootIdOf(ctx, sessionId) || sessionId;
                const sessions = { ...state.sessions };
                delete sessions[key];
                writeState({ ...state, sessions });
                sendJson(response, 200, statusPayload(ctx, sessionId, key));
                return;
              }

              // 单会话。按根会话存：对子代理操作等同于操作它所属的主会话，
              // 避免出现「子代理有自己的记录、主会话却读不到」的孤儿状态。
              if (!sessionId) {
                sendJson(response, 400, { ok: false, error: "sessionId required" });
                return;
              }
              const key = rootIdOf(ctx, sessionId) || sessionId;
              const sessions = { ...state.sessions, [key]: { mode: rawMode, updatedAt: now } };
              writeState({ ...state, sessions });
              // 立即把该会话的权限预设刷成新模式的，免重启、当轮即生效。
              const permission = await applySessionPermission(
                ctx,
                sessionById(ctx, key),
                rawMode,
              );
              // 不写共享 config：装配期按会话作用域求值，写入会串味。
              sendJson(response, 200, {
                ...statusPayload(ctx, sessionId, key),
                permission,
              });
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            }
          },
        },
        "dsh-purge-mode: mode",
      );
      return () => {
        if (typeof dispose === "function") dispose();
      };
    });
  });
}
