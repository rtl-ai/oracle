import type { ProviderDomAdapter, ProviderDomFlowContext } from "../providerDomFlow.js";
import { joinSelectors } from "../providerDomFlow.js";

const UI_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 20 * 60_000;
const LOG_INTERVAL_MS = 15_000;

interface GeminiDeepResearchState {
  inputTimeoutMs?: number;
  timeoutMs?: number;
}

export const GEMINI_DEEP_RESEARCH_SELECTORS = {
  input: [
    "rich-textarea .ql-editor",
    '[role="textbox"][aria-label*="prompt" i]',
    'div[contenteditable="true"]',
  ],
  sendButton: ["button.send-button", 'button[aria-label="Send message"]'],
  toolsButton: ["button.toolbox-drawer-button", 'button[aria-label="Tools"]'],
  toolsMenuItem: [
    "toolbox-drawer-item button",
    '[role="menuitemcheckbox"]',
    ".toolbox-drawer-item-list-button",
  ],
  confirmationWidget: ["deep-research-confirmation-widget"],
  startResearchButton: ['[data-test-id="confirm-button"]'],
  researchTitle: ['[data-test-id="title"]'],
  immersivePanel: ["deep-research-immersive-panel"],
  reportContent: [
    ".markdown-main-panel",
    ".markdown",
    '[class*="markdown"]',
    "message-content",
    ".model-response-text",
  ],
  exportMenuButton: ['[data-test-id="export-menu-button"]'],
  loading: [
    '[aria-busy="true"]',
    ".loading-shimmer",
    "mat-spinner",
    ".mat-progress-spinner",
    '[role="progressbar"]:not([aria-valuenow="100"])',
    '[data-streaming="true"]',
    '[data-generating="true"]',
  ],
  responseTurn: ["model-response"],
  responseText: ["message-content", ".model-response-text message-content"],
  responseComplete: [".response-footer.complete"],
} as const;

function asSelectorLiteral(selectors: readonly string[]): string {
  return JSON.stringify(joinSelectors(selectors));
}

function readTimeouts(ctx: ProviderDomFlowContext): {
  uiTimeoutMs: number;
  responseTimeoutMs: number;
} {
  const state = ctx.state as GeminiDeepResearchState | undefined;
  const uiTimeoutMs =
    typeof state?.inputTimeoutMs === "number" && Number.isFinite(state.inputTimeoutMs)
      ? Math.max(1_000, state.inputTimeoutMs)
      : UI_TIMEOUT_MS;
  const responseTimeoutMs =
    typeof state?.timeoutMs === "number" && Number.isFinite(state.timeoutMs)
      ? Math.max(1_000, state.timeoutMs)
      : RESPONSE_TIMEOUT_MS;
  return { uiTimeoutMs, responseTimeoutMs };
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[gemini-web] Waiting for Gemini UI to load...");
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.input);
  const { uiTimeoutMs } = readTimeouts(ctx);
  const uiDeadline = Date.now() + uiTimeoutMs;
  let sawLoginRedirect = false;

  while (Date.now() < uiDeadline) {
    const state = await ctx.evaluate<{ ready?: boolean; requiresLogin?: boolean }>(
      `(() => {
        const editor = document.querySelector(${inputSelector});
        const href = location.href || '';
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const requiresLogin =
          href.includes('accounts.google.com') ||
          (bodyText.includes('sign in') && bodyText.includes('google'));
        return { ready: Boolean(editor), requiresLogin };
      })()`,
    );
    if (state?.ready) {
      return;
    }
    if (state?.requiresLogin) {
      sawLoginRedirect = true;
    }
    await ctx.delay(1_000);
  }

  if (sawLoginRedirect) {
    throw new Error("Gemini is showing a sign-in flow. Please sign in in Chrome and retry.");
  }
  throw new Error("Timed out waiting for Gemini UI prompt input to become ready.");
}

async function selectMode(ctx: ProviderDomFlowContext): Promise<void> {
  const toolsButtonSelectors = asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.toolsButton);
  const toolsClickResult = await ctx.evaluate<string>(
    `(() => {
      const btn = document.querySelector(${toolsButtonSelectors});
      if (btn instanceof HTMLElement) {
        btn.click();
        return 'clicked';
      }
      return 'not-found';
    })()`,
  );
  if (toolsClickResult !== "clicked") {
    throw new Error("Unable to open Gemini tools menu; Deep Research toggle is not accessible.");
  }
  await ctx.delay(1_000);

  const menuItemSelectors = asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.toolsMenuItem);
  const deepResearchClickResult = await ctx.evaluate<{
    status?: string;
    available?: string[];
    requiresLogin?: boolean;
  }>(
    `(() => {
      const items = Array.from(document.querySelectorAll(${menuItemSelectors}));
      const isDisabled = (node) => {
        if (!(node instanceof HTMLElement)) return true;
        const classText = String(node.className || '').toLowerCase();
        return (
          (node instanceof HTMLButtonElement && node.disabled) ||
          node.getAttribute('aria-disabled') === 'true' ||
          classText.includes('disabled') ||
          node.closest('.disabled, .mdc-list-item--disabled')
        );
      };
      const available = items
        .map((item) => item.textContent?.trim() || item.getAttribute('aria-label') || '')
        .filter(Boolean);
      const pageText = (document.body?.innerText || '').toLowerCase();
      const requiresLogin = pageText.includes('sign in') || pageText.includes('로그인');
      for (const item of items) {
        const text = item.textContent?.trim().toLowerCase() ?? '';
        const label = item.getAttribute('aria-label')?.toLowerCase() ?? '';
        if (!text.includes('deep research') && !label.includes('deep research')) continue;
        if (isDisabled(item)) {
          return { status: 'disabled', available, requiresLogin };
        }
        if (item instanceof HTMLElement) item.click();
        return { status: 'clicked', available, requiresLogin };
      }
      return { status: 'not-found', available, requiresLogin };
    })()`,
  );
  if (deepResearchClickResult?.status === "disabled") {
    const guidance = deepResearchClickResult.requiresLogin
      ? " Gemini is showing a sign-in prompt; sign in to Gemini in the browser profile and retry."
      : " The feature may require a Gemini Advanced/Pro entitlement or a different account.";
    throw new Error(`Gemini Deep Research is disabled in the Tools menu.${guidance}`);
  }
  if (deepResearchClickResult?.status !== "clicked") {
    const available = deepResearchClickResult?.available?.length
      ? ` Available tools: ${deepResearchClickResult.available.join(", ")}.`
      : "";
    throw new Error(`Unable to select "Deep Research" from Gemini tools menu.${available}`);
  }
  await ctx.delay(1_500);
}

async function typePrompt(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[gemini-web] Typing Deep Research prompt...");
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.input);
  const typeResult = await ctx.evaluate<string>(
    `(() => {
      const PROMPT = ${JSON.stringify(ctx.prompt)};
      const editor = document.querySelector(${inputSelector});
      if (!(editor instanceof HTMLElement)) return 'no-editor';
      const dispatchInputEvents = () => {
        try {
          editor.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              composed: true,
              inputType: 'insertText',
              data: PROMPT,
            }),
          );
        } catch {}
        try {
          editor.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              composed: true,
              inputType: 'insertText',
              data: PROMPT,
            }),
          );
        } catch {
          editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        }
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', bubbles: true }));
      };
      const hasTypedText = () => (editor.textContent || '').trim().length > 0;
      const placeCaret = () => {
        const selection = window.getSelection?.();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      };
      const setParagraphText = () => {
        editor.textContent = '';
        const lines = PROMPT.split(/\\r?\\n/);
        for (const line of lines.length > 0 ? lines : ['']) {
          const p = document.createElement('p');
          if (line.length > 0) {
            p.textContent = line;
          } else {
            p.appendChild(document.createElement('br'));
          }
          editor.appendChild(p);
        }
        editor.classList?.remove('ql-blank');
        dispatchInputEvents();
      };
      editor.focus();
      editor.click?.();
      editor.textContent = '';
      placeCaret();
      if (typeof document.execCommand === 'function') {
        document.execCommand('insertText', false, PROMPT);
        dispatchInputEvents();
      }
      if (!hasTypedText()) {
        setParagraphText();
      }
      return hasTypedText() ? 'typed' : 'empty';
    })()`,
  );
  if (typeResult !== "typed") {
    throw new Error(`Failed to type Gemini prompt (status=${typeResult ?? "unknown"}).`);
  }
  await ctx.delay(500);
}

async function submitPrompt(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[gemini-web] Sending Deep Research prompt...");
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.input);
  const sendButtonSelectors = asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.sendButton);
  const sendResult = await ctx.evaluate<string>(
    `(() => {
      const btn = document.querySelector(${sendButtonSelectors});
      if (btn instanceof HTMLElement) {
        if (
          (btn instanceof HTMLButtonElement && btn.disabled) ||
          btn.getAttribute('aria-disabled') === 'true'
        ) {
          return 'disabled';
        }
        btn.click();
        return 'clicked';
      }
      const editor = document.querySelector(${inputSelector});
      if (editor instanceof HTMLElement) {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        return 'enter';
      }
      return 'not-found';
    })()`,
  );
  if (sendResult !== "clicked" && sendResult !== "enter") {
    throw new Error("Failed to submit prompt in Gemini Deep Research mode.");
  }
}

async function waitForResponse(
  ctx: ProviderDomFlowContext,
): Promise<{ text: string; html?: string }> {
  ctx.log?.("[gemini-web] Waiting for Deep Research report (this may take a while)...");
  const selectors = {
    confirmationWidget: asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.confirmationWidget),
    startResearchButton: asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.startResearchButton),
    researchTitle: asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.researchTitle),
    immersivePanel: asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.immersivePanel),
    reportContent: asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.reportContent),
    exportMenuButton: asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.exportMenuButton),
    loading: asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.loading),
    responseTurn: asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.responseTurn),
    responseText: asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.responseText),
    responseComplete: asSelectorLiteral(GEMINI_DEEP_RESEARCH_SELECTORS.responseComplete),
  };
  const { responseTimeoutMs } = readTimeouts(ctx);
  const responseDeadline = Date.now() + responseTimeoutMs;
  let lastLog = 0;
  let lastTextLength = 0;

  while (Date.now() < responseDeadline) {
    const payload = await ctx.evaluate<string>(
      `(() => {
        const visible = (el) =>
          el instanceof HTMLElement &&
          el.getBoundingClientRect().width > 0 &&
          el.getBoundingClientRect().height > 0;

        const panel = document.querySelector(${selectors.immersivePanel});
        if (panel) {
          const content = panel.querySelector(${selectors.reportContent}) || panel;
          const text = content.textContent?.trim() || '';
          const html = content instanceof HTMLElement ? content.innerHTML : '';
          const loading = Array.from(panel.querySelectorAll(${selectors.loading})).some(visible);
          const exportButton = document.querySelector(${selectors.exportMenuButton});
          const hasExport = exportButton instanceof HTMLElement && visible(exportButton);
          const complete = hasExport && text.length > 0;
          return JSON.stringify({
            status: complete ? 'done' : 'researching',
            text,
            html,
            length: text.length,
            hasExport,
            loading,
          });
        }

        const widgets = Array.from(document.querySelectorAll(${selectors.confirmationWidget})).filter(visible);
        const widget = widgets[widgets.length - 1];
        if (widget) {
          const directStart = widget.querySelector(${selectors.startResearchButton});
          const buttons = Array.from(widget.querySelectorAll('button'));
          const textStart = buttons.find((btn) =>
            (btn.textContent || '').toLowerCase().includes('start research') ||
            (btn.textContent || '').includes('연구 시작')
          );
          const start = directStart || textStart;
          const title = widget.querySelector(${selectors.researchTitle})?.textContent?.trim() || '';
          if (start instanceof HTMLElement && visible(start)) {
            start.click();
            return JSON.stringify({ status: 'started', title });
          }
          return JSON.stringify({ status: 'planning', title });
        }

        return JSON.stringify({ status: 'waiting' });
      })()`,
    );

    try {
      const parsed = JSON.parse(payload ?? "{}") as {
        status?: string;
        title?: string;
        text?: string;
        html?: string;
        length?: number;
      };
      if (parsed.status === "done" && typeof parsed.text === "string" && parsed.text.length > 0) {
        return { text: parsed.text, html: parsed.html };
      }
      const now = Date.now();
      const length = parsed.length ?? parsed.text?.length ?? 0;
      if (now - lastLog > LOG_INTERVAL_MS || length > lastTextLength) {
        const title = parsed.title ? ` title="${parsed.title}"` : "";
        ctx.log?.(
          `[gemini-web] Deep Research ${parsed.status ?? "waiting"}${title} (${length} chars)`,
        );
        lastLog = now;
        lastTextLength = Math.max(lastTextLength, length);
      }
    } catch {
      // ignore transient parse errors while polling the live page
    }
    await ctx.delay(5_000);
  }

  throw new Error(
    `Deep Research timed out waiting for report (${Math.ceil(responseTimeoutMs / 1000)} seconds).`,
  );
}

export const geminiDeepResearchDomProvider: ProviderDomAdapter = {
  providerName: "gemini-web",
  waitForUi,
  selectMode,
  typePrompt,
  submitPrompt,
  waitForResponse,
};
