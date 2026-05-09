import type { ChromeClient, BrowserLogger, BrowserAgentMode } from "../types.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import { delay } from "../utils.js";

export interface AgentModeResult {
  connectorDismissed: boolean;
}

/**
 * Enables/disables ChatGPT Agent mode and ensures all connectors are turned off.
 *
 * The ChatGPT composer tools (+) menu has this structure:
 *   + button (#composer-plus-btn)
 *     [role=menu]
 *       - Upload, Google Drive, Sharepoint ...
 *       - Create image, Deep research, Web search ...
 *       - "More" (aria-haspopup=menu, needs HOVER to open submenu)
 *         [role=menu] (submenu)
 *           - Agent mode  [role=menuitemradio]
 *           - GitHub      [role=menuitemradio] connector
 *           - Gmail       [role=menuitemradio] connector
 *           - Google Drive [role=menuitemradio] connector
 *
 * After enabling agent mode, connected connectors may auto-activate and show:
 *   1. A safety dialog (#modal-agent-connectors-safety) - click "Turn off connectors"
 *   2. A separate connector button (button.composer-btn with <img>) next to the + button
 *      that opens a connector menu with [role=switch] toggles
 *
 * This function handles all three scenarios.
 */
export async function ensureAgentMode(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  mode: BrowserAgentMode,
  logger: BrowserLogger,
): Promise<AgentModeResult> {
  if (mode === "current") {
    logger("Agent mode: keeping current state");
    return { connectorDismissed: false };
  }

  const wantOn = mode === "on";

  // Close any stale menus/dialogs before starting
  await pressEscape(Runtime);
  await delay(300);
  await pressEscape(Runtime);
  await delay(300);

  // Step 1: Open the + menu via CDP mouse click (synthetic .click() doesn't work)
  const plusPos = await evalReturnValue<{ x: number; y: number } | null>(
    Runtime,
    `(() => {
    const btn = document.querySelector('#composer-plus-btn');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    if (r.width <= 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`,
  );

  if (!plusPos) {
    await logDomFailure(Runtime, logger, "agent-mode-plus-btn");
    throw new Error("Unable to locate the ChatGPT tools (+) button.");
  }

  await cdpClick(Input, plusPos.x, plusPos.y);
  await delay(800);

  // Step 2: Hover over "More" to open the submenu
  const morePos = await evalReturnValue<{ x: number; y: number } | null>(
    Runtime,
    `(() => {
    const items = Array.from(document.querySelectorAll('[role=menuitem][aria-haspopup=menu]'));
    const more = items.find(i => (i.textContent || '').trim() === 'More');
    if (!more || more.getBoundingClientRect().width <= 0) return null;
    const r = more.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`,
  );

  if (!morePos) {
    // Close the menu and bail
    await pressEscape(Runtime);
    await logDomFailure(Runtime, logger, "agent-mode-more-item");
    throw new Error("Unable to find 'More' submenu in the ChatGPT tools menu.");
  }

  await Input.dispatchMouseEvent({ type: "mouseMoved", x: morePos.x, y: morePos.y });
  await delay(1000);

  // Step 3: Find "Agent mode" in the submenu and check its state
  const agentItem = await evalReturnValue<{
    x: number;
    y: number;
    checked: string;
  } | null>(
    Runtime,
    `(() => {
    const items = Array.from(document.querySelectorAll('[role=menuitemradio]'));
    const agent = items.find(i => {
      const t = (i.textContent || '').trim().toLowerCase();
      return t === 'agent mode' || t === 'agenttilstand';
    });
    if (!agent || agent.getBoundingClientRect().width <= 0) return null;
    const r = agent.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, checked: agent.getAttribute('aria-checked') || 'false' };
  })()`,
  );

  if (!agentItem) {
    await pressEscape(Runtime);
    await logDomFailure(Runtime, logger, "agent-mode-item");
    throw new Error("Unable to find 'Agent mode' in the ChatGPT tools submenu.");
  }

  const isCurrentlyOn = agentItem.checked === "true";

  if (wantOn && isCurrentlyOn) {
    logger("Agent mode: already on");
    await pressEscape(Runtime);
    await delay(300);
    const dismissed = await disableActiveConnectors(Runtime, Input, logger);
    return { connectorDismissed: dismissed };
  }

  if (!wantOn && !isCurrentlyOn) {
    logger("Agent mode: already off");
    await pressEscape(Runtime);
    return { connectorDismissed: false };
  }

  // Step 4: Click agent mode to toggle
  await cdpClick(Input, agentItem.x, agentItem.y);
  await delay(1500);

  logger(`Agent mode: ${wantOn ? "enabled" : "disabled"}`);

  // Step 5: After enabling, dismiss connector safety dialog and disable connectors
  let connectorDismissed = false;
  if (wantOn) {
    // Handle the "Using agent mode with connectors" safety dialog
    connectorDismissed = await dismissConnectorSafetyDialog(Runtime, Input, logger);
    // Disable any active connectors (GitHub, Gmail, etc)
    const connectorsDisabled = await disableActiveConnectors(Runtime, Input, logger);
    connectorDismissed = connectorDismissed || connectorsDisabled;
  }

  return { connectorDismissed };
}

/**
 * Dismiss the "Using agent mode with connectors" safety modal.
 * Always clicks "Turn off connectors" to keep automation clean.
 */
async function dismissConnectorSafetyDialog(
  Runtime: ChromeClient["Runtime"],
  _Input: ChromeClient["Input"],
  logger: BrowserLogger,
): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    await delay(500);
    const result = await evalReturnValue<string>(
      Runtime,
      `(() => {
      ${buildClickDispatcher()}
      const normalize = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

      // Primary: exact testid
      const modal = document.querySelector('#modal-agent-connectors-safety, [data-testid="modal-agent-connectors-safety"]');
      if (modal && modal instanceof HTMLElement && modal.getBoundingClientRect().width > 0) {
        const buttons = Array.from(modal.querySelectorAll('button'));
        const turnOff = buttons.find(b => {
          const t = normalize(b.textContent || '');
          return t.includes('turn off') || t.includes('sluk') || t.includes('deaktiver');
        });
        if (turnOff) { dispatchClickSequence(turnOff); return 'dismissed-turn-off'; }
        const closeBtn = modal.querySelector('[data-testid="close-button"]');
        if (closeBtn) { dispatchClickSequence(closeBtn); return 'dismissed-close'; }
      }

      // Fallback: any dialog with "connector" text
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter(el => el instanceof HTMLElement && el.getBoundingClientRect().width > 50);
      for (const d of dialogs) {
        if (!normalize(d.textContent || '').includes('connector')) continue;
        const buttons = Array.from(d.querySelectorAll('button'));
        const turnOff = buttons.find(b => {
          const t = normalize(b.textContent || '');
          return t.includes('turn off') || t.includes('sluk') || t.includes('deaktiver');
        });
        if (turnOff) { dispatchClickSequence(turnOff); return 'dismissed-turn-off'; }
        const closeBtn = d.querySelector('[data-testid="close-button"]');
        if (closeBtn) { dispatchClickSequence(closeBtn); return 'dismissed-close'; }
      }
      return 'none';
    })()`,
    );

    if (result?.startsWith("dismissed")) {
      logger(`Connector safety dialog dismissed (${result})`);
      return true;
    }
  }
  return false;
}

/**
 * Check for active connector buttons in the composer and disable them.
 *
 * When connectors are active, a separate button (button.composer-btn with an <img>)
 * appears next to the + button. Clicking it opens a menu with [role=switch] toggles
 * for each connector. We toggle all checked switches OFF.
 */
async function disableActiveConnectors(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  logger: BrowserLogger,
): Promise<boolean> {
  // Check if any connector button exists (button.composer-btn with img, not the + button)
  const connectorBtn = await evalReturnValue<{ x: number; y: number; alt: string } | null>(
    Runtime,
    `(() => {
      const btns = Array.from(document.querySelectorAll('button.composer-btn'));
      for (const b of btns) {
        if (b.id === 'composer-plus-btn') continue;
        const img = b.querySelector('img');
        if (!img) continue;
        const r = b.getBoundingClientRect();
        if (r.width <= 0) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, alt: img.alt || '' };
      }
      return null;
    })()`,
  );

  if (!connectorBtn) {
    return false; // No active connectors
  }

  logger(`Active connector detected: ${connectorBtn.alt}. Disabling...`);

  // Click the connector button to open its menu
  await cdpClick(Input, connectorBtn.x, connectorBtn.y);
  await delay(800);

  // Toggle OFF all checked switches in the connector menu
  const disabled = await evalReturnValue<string[]>(
    Runtime,
    `(() => {
    ${buildClickDispatcher()}
    const menus = Array.from(document.querySelectorAll('[role=menu]'))
      .filter(el => el.getBoundingClientRect().width > 30);
    const disabled = [];
    for (const menu of menus) {
      const items = Array.from(menu.querySelectorAll('[role=menuitemcheckbox], [role=switch]'));
      let currentLabel = '';
      for (const item of items) {
        const text = (item.textContent || '').trim();
        if (item.getAttribute('role') === 'menuitemcheckbox') {
          currentLabel = text;
          continue;
        }
        if (item.getAttribute('role') === 'switch' && item.getAttribute('aria-checked') === 'true') {
          // Skip "Use cloud browser" - that's not a connector
          if (currentLabel.toLowerCase().includes('cloud browser')) continue;
          dispatchClickSequence(item);
          disabled.push(currentLabel || 'unknown');
        }
      }
    }
    return disabled;
  })()`,
  );

  if (disabled && disabled.length > 0) {
    logger(`Disabled connectors: ${disabled.join(", ")}`);
  }

  // Close the connector menu
  await pressEscape(Runtime);
  await delay(300);

  return (disabled?.length ?? 0) > 0;
}

async function cdpClick(Input: ChromeClient["Input"], x: number, y: number): Promise<void> {
  await Input.dispatchMouseEvent({
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await Input.dispatchMouseEvent({
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function pressEscape(Runtime: ChromeClient["Runtime"]): Promise<void> {
  await Runtime.evaluate({
    expression: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))`,
  }).catch(() => undefined);
}

async function evalReturnValue<T>(
  Runtime: ChromeClient["Runtime"],
  expression: string,
): Promise<T | null> {
  try {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    return (result?.value as T) ?? null;
  } catch {
    return null;
  }
}

export function buildAgentModeExpressionForTest(): string {
  // Return a representative expression for unit test assertions
  return `${buildClickDispatcher()}\n// agent-mode: uses CDP Input for real clicks, #composer-plus-btn, [role=menuitemradio], [role=switch]`;
}
