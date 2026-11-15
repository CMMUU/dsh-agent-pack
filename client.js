/**
 * dsh-purge-mode 浏览器半边：输入框右侧的「方案」层级下拉。
 *
 * 交互
 * ----
 * 一级菜单管**本会话**（原生 / purge），二级菜单管**批量**（全部原生 /
 * 全部 purge / 清除本会话记忆）。视觉、位置、原语全部沿用宿主自己的
 * `Menu`（与权限选择器同一套），因此点击外部、Esc、方向键、焦点回归都由
 * 原语负责；`submenu` / `separator` / `label` 也是原语原生支持的条目类型。
 *
 * 提交时机：点某一项才发请求，选中后菜单收起，旁边短暂显示「下轮生效」。
 */
window.__ModuleLoader__.load({
  id: "dsh-purge-mode",
  factory(require) {
    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;
    const { Menu } = primitives;
    const ChevronDown = primitives.IconChevronDownOutlineRegular;

    const NS = "dsh-purge-mode";
    const ENDPOINT = "/dsh-purge-mode/mode";

    const DICTIONARIES = {
      zh: {
        trigger: "方案",
        menuTitle: "本会话方案（下一轮生效）",
        native: "原生",
        nativeHint: "官方提示词 · 审批会问",
        purge: "purge",
        purgeHint: "operator 注入 · 全放行",
        bulkTitle: "应用到所有会话",
        bulkNative: "全部设为原生",
        bulkNativeHint: "含默认值与已记忆会话",
        bulkPurge: "全部设为 purge",
        bulkPurgeHint: "含默认值与已记忆会话",
        forget: "清除本会话记忆",
        forgetHint: "回到默认（原生）",
        switched: "下轮生效",
        cleared: "已回默认",
        bulkDone: "已全部设置",
        failed: "切换失败：{error}",
        unknown: "读取中",
        defaultTag: "默认",
        inheritTag: "跟随默认",
      },
      en: {
        trigger: "Scheme",
        menuTitle: "This session (next turn)",
        native: "Native",
        nativeHint: "official prompt · approval asks",
        purge: "purge",
        purgeHint: "operator inject · full access",
        bulkTitle: "Apply to all sessions",
        bulkNative: "All native",
        bulkNativeHint: "defaults and remembered sessions",
        bulkPurge: "All purge",
        bulkPurgeHint: "defaults and remembered sessions",
        forget: "Forget this session",
        forgetHint: "fall back to default (native)",
        switched: "next turn",
        cleared: "back to default",
        bulkDone: "applied to all",
        failed: "Switch failed: {error}",
        unknown: "loading",
        defaultTag: "default",
        inheritTag: "follows default",
      },
    };

    const STYLES = `
.dshpm-anchor{display:inline-flex;align-items:center;max-width:220px}
.dshpm-trigger{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;max-width:100%;padding:0 6px 0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:13px/20px var(--ds-font-sans,system-ui,sans-serif);font-weight:500}
.dshpm-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dshpm-trigger:disabled{color:var(--dsw-alias-label-dimmed,currentColor);cursor:default}
.dshpm-trigger:focus-visible{outline:0;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.dshpm-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-caption,#999)}
.dshpm-dot[data-mode="native"]{background:var(--dsw-alias-brand-primary,#4d6bfe)}
.dshpm-dot[data-mode="purge"]{background:var(--dsw-alias-state-success-primary,#3ca05a)}
.dshpm-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpm-chevron{width:14px;height:14px;flex:none;color:var(--dsw-alias-label-caption,currentColor);transition:transform .12s}
.dshpm-chevron[data-open="1"]{transform:rotate(180deg)}
.dshpm-note{font:11px/1 var(--ds-font-sans,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;margin-left:6px}
.dshpm-opt{display:inline-flex;align-items:baseline;gap:8px;min-width:0}
.dshpm-opt b{font-weight:500}
.dshpm-opt em{font-style:normal;font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}
`;

    let stylesInstalled = false;
    function ensureStyles() {
      if (stylesInstalled || typeof document === "undefined") return;
      try {
        const style = document.createElement("style");
        style.setAttribute("data-dsh-purge-mode", "1");
        style.textContent = STYLES;
        document.head.append(style);
        stylesInstalled = true;
      } catch {
        /* ignore */
      }
    }

    async function readJson(response) {
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }

    async function requestMode(sessionId, body) {
      const url = sessionId
        ? `${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`
        : ENDPOINT;
      const response = await fetch(
        url,
        body
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              cache: "no-store",
              credentials: "same-origin",
              body: JSON.stringify(body),
            }
          : { cache: "no-store", credentials: "same-origin" },
      );
      const data = await readJson(response);
      if (!response.ok || !data || data.ok === false) {
        throw new Error(String(data?.error ?? `${response.status} ${response.statusText}`));
      }
      return data;
    }

    function optionLabel(text, hint) {
      return h("span", { className: "dshpm-opt" }, h("b", null, text), h("em", null, hint));
    }

    function ModeSelect(props) {
      const { sessionId, t } = props;
      const [mode, setMode] = useState("");
      const [defaultMode, setDefaultMode] = useState("");
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState("");
      const [error, setError] = useState("");
      const noteTimer = useRef(null);

      const flash = useCallback((text) => {
        setNote(text);
        if (noteTimer.current) window.clearTimeout(noteTimer.current);
        noteTimer.current = window.setTimeout(() => setNote(""), 2600);
      }, []);

      const load = useCallback(() => {
        return requestMode(sessionId)
          .then((data) => {
            setMode(String(data?.mode ?? ""));
            setDefaultMode(String(data?.defaultMode ?? ""));
          })
          .catch(() => {
            setMode("");
            setDefaultMode("");
          });
      }, [sessionId]);

      useEffect(() => {
        ensureStyles();
        let alive = true;
        load().then(() => {
          if (!alive) return;
        });
        return () => {
          alive = false;
          if (noteTimer.current) window.clearTimeout(noteTimer.current);
        };
      }, [load]);

      // 选中即提交：菜单先关，再发请求。
      const submit = useCallback(
        async (body, nextNote) => {
          setOpen(false);
          if (busy || !body) return;
          setBusy(true);
          setError("");
          try {
            const data = await requestMode(sessionId, body);
            setMode(String(data?.mode ?? ""));
            setDefaultMode(String(data?.defaultMode ?? ""));
            flash(nextNote);
          } catch (failure) {
            setError(t("failed").replace("{error}", String(failure?.message ?? failure)));
          } finally {
            setBusy(false);
          }
        },
        [busy, flash, sessionId, t],
      );

      const choose = useCallback(
        (id) => {
          if (id === "native" && mode !== "native") {
            void submit({ sessionId, mode: "native" }, t("switched"));
            return;
          }
          if (id === "purge" && mode !== "purge") {
            void submit({ sessionId, mode: "purge" }, t("switched"));
            return;
          }
          setOpen(false);
        },
        [mode, submit, sessionId, t],
      );

      const chooseBulk = useCallback(
        (id) => {
          if (id === "bulk-native") {
            void submit({ scope: "all", mode: "native" }, t("bulkDone"));
            return;
          }
          if (id === "bulk-purge") {
            void submit({ scope: "all", mode: "purge" }, t("bulkDone"));
            return;
          }
          if (id === "forget") {
            void submit({ sessionId, mode: null }, t("cleared"));
            return;
          }
          setOpen(false);
        },
        [submit, sessionId, t],
      );

      const items = [
        { type: "label", id: "title", text: t("menuTitle") },
        { id: "native", label: optionLabel(t("native"), t("nativeHint")) },
        { id: "purge", label: optionLabel(t("purge"), t("purgeHint")) },
        { type: "separator", id: "sep" },
        {
          id: "bulk",
          label: t("bulkTitle"),
          submenu: [
            { id: "bulk-native", label: optionLabel(t("bulkNative"), t("bulkNativeHint")) },
            { id: "bulk-purge", label: optionLabel(t("bulkPurge"), t("bulkPurgeHint")) },
            // 子菜单条目不会被宿主的 Menu 识别为 separator（只有顶层 items 走那个判断），
            // 放 separator 会渲染成一个空按钮，所以这里不加分隔线。
            { id: "forget", label: optionLabel(t("forget"), t("forgetHint")) },
          ],
        },
      ];

      const currentLabel =
        mode === "native" ? t("native") : mode === "purge" ? t("purge") : t("unknown");
      const inherited = Boolean(mode) && mode === defaultMode;

      const onSelect = (id) => {
        if (id === "bulk") return; // 父项只展开子菜单
        if (id.startsWith("bulk-") || id === "forget") chooseBulk(id);
        else choose(id);
      };

      return h(
        React.Fragment,
        null,
        h(Menu, {
          open,
          items,
          selectedId: mode || undefined,
          onSelect,
          onClose: () => setOpen(false),
          side: "top",
          portal: true,
          dense: true,
          className: "dshpm-anchor",
          anchor: h(
            "button",
            {
              type: "button",
              className: "dshpm-trigger",
              title: error || t("menuTitle"),
              disabled: busy,
              "aria-haspopup": "menu",
              "aria-expanded": open ? "true" : "false",
              "aria-label": `${t("trigger")}: ${currentLabel}${inherited ? ` (${t("inheritTag")})` : ""}`,
              onClick: () => setOpen((prev) => !prev),
            },
            h("span", { className: "dshpm-dot", "data-mode": mode || "unknown", "aria-hidden": "true" }),
            h("span", { className: "dshpm-label" }, currentLabel),
            inherited ? h("span", { className: "dshpm-note" }, t("defaultTag")) : null,
            ChevronDown
              ? h(ChevronDown, { className: "dshpm-chevron", "data-open": open ? "1" : "0", "aria-hidden": "true" })
              : null,
          ),
        }),
        note ? h("span", { className: "dshpm-note" }, note) : null,
      );
    }

    /**
     * 客户端插件入口：把「方案」层级下拉挂到输入框右侧。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "dsh-purge-mode: dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
          {
            name: "conversation.input.right",
            id: "dsh-purge-mode",
            order: 30,
            inject: (sessionId) => ({ sessionId, t }),
          },
          ModeSelect,
        ),
      );
    }

    return { inject: ["slots", "locale"], apply };
  },
});
