#!/usr/bin/env node
"use strict";

class TelegramClient {
  constructor(botToken) {
    this.botToken = String(botToken || "").trim();
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
    this.offset = 0;
    this.polling = false;
    this.abortController = null;
  }

  async call(method, params = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal
      });
      const json = await res.json();
      if (!json.ok) {
        const desc = json.description || `HTTP ${res.status}`;
        const err = new Error(`Telegram ${method}: ${desc}`);
        err.code = json.error_code || res.status;
        throw err;
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async getMe() {
    return this.call("getMe", {}, 15000);
  }

  async setMyCommands(commands) {
    return this.call("setMyCommands", { commands }, 15000);
  }

  async sendMessage(chatId, text, opts = {}) {
    const payload = {
      chat_id: chatId,
      text: truncateTelegram(text, 3900),
      disable_web_page_preview: true
    };
    if (opts.threadId != null) payload.message_thread_id = Number(opts.threadId);
    if (opts.parseMode) payload.parse_mode = opts.parseMode;
    if (opts.silent) payload.disable_notification = true;
    if (opts.buttons && opts.buttons.length > 0) {
      payload.reply_markup = { inline_keyboard: opts.buttons };
    }
    return this.call("sendMessage", payload, 20000);
  }

  async editMessageText(chatId, messageId, text, opts = {}) {
    const payload = {
      chat_id: chatId,
      message_id: Number(messageId),
      text: truncateTelegram(text, 3900),
      disable_web_page_preview: true
    };
    if (opts.parseMode) payload.parse_mode = opts.parseMode;
    if (opts.buttons) {
      payload.reply_markup = { inline_keyboard: opts.buttons };
    }
    try {
      return await this.call("editMessageText", payload, 15000);
    } catch (err) {
      if (String(err.message || "").includes("message is not modified")) {
        return null;
      }
      throw err;
    }
  }

  async pinMessage(chatId, messageId) {
    try {
      return await this.call("pinChatMessage", {
        chat_id: chatId,
        message_id: Number(messageId),
        disable_notification: true
      }, 15000);
    } catch (_) {
      return null;
    }
  }

  async answerCallback(callbackQueryId, text = "", showAlert = false) {
    try {
      return await this.call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: text.slice(0, 180),
        show_alert: Boolean(showAlert)
      }, 10000);
    } catch (_) {
      return null;
    }
  }

  async getUpdates(timeoutSec = 25) {
    const controller = new AbortController();
    this.abortController = controller;
    const timer = setTimeout(() => controller.abort(), (timeoutSec + 12) * 1000);
    try {
      const res = await fetch(`${this.baseUrl}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: this.offset,
          timeout: timeoutSec,
          allowed_updates: ["message", "callback_query"]
        }),
        signal: controller.signal
      });
      const json = await res.json();
      if (!json.ok) {
        throw new Error(json.description || `HTTP ${res.status}`);
      }
      const updates = json.result || [];
      if (updates.length > 0) {
        this.offset = updates[updates.length - 1].update_id + 1;
      }
      return updates;
    } finally {
      clearTimeout(timer);
      this.abortController = null;
    }
  }

  startPolling(onUpdate, onError) {
    this.polling = true;
    let backoffMs = 1500;

    const loop = async () => {
      while (this.polling) {
        try {
          const updates = await this.getUpdates(25);
          backoffMs = 1500;
          for (const upd of updates) {
            try {
              await onUpdate(upd);
            } catch (err) {
              if (onError) onError(err);
            }
          }
        } catch (err) {
          if (!this.polling) break;
          if (onError) onError(err);
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 15000);
        }
      }
    };

    loop();
  }

  stopPolling() {
    this.polling = false;
    if (this.abortController) {
      try { this.abortController.abort(); } catch (_) {}
    }
  }
}

function truncateTelegram(text, maxLen) {
  const s = String(text || "");
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 28) + "\n\n... [truncado pelo worker]";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { TelegramClient, truncateTelegram };
