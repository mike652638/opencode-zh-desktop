/**
 * Injection script that runs inside the Electron renderer process.
 * Uses CDP's Page.addScriptToEvaluateOnNewDocument, so it runs
 * before any page script on every navigation.
 *
 * Placeholder __TRANSLATIONS__ will be replaced at injection time.
 *
 * WARNING: This file is NOT inside a template literal — all regex
 * escape sequences are literal. Do NOT wrap this in backticks!
 */
(function () {
  "use strict";

  var TRANSLATIONS = __TRANSLATIONS__;

  // Startup marker — appears in console before any try/catch
  console.log("[opencode-zh] ===== Injection script STARTED =====");

  // ---- Locale setter ----

  function setLocale() {
    try {
      if (window.api && window.api.storeSet) {
        var langData = JSON.stringify({ locale: "zh" });
        window.api.storeSet("opencode.global.dat", "language", langData);
        console.log("[opencode-zh] Locale set to zh");
      }
    } catch (e) {
      console.warn("[opencode-zh] Failed to set locale:", e);
    }
  }

  // ---- DOM text replacement ----

  var SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "INPUT"]);
  var replacedNodes = new Set();

  function shouldTranslate(text) {
    if (!text || text.trim().length < 2) return false;
    var trimmed = text.trim();
    // 排除 URL 和文件路径
    if (/^(https?:|file:|\/|[A-Z]:\\)/.test(trimmed)) return false;
    // 排除纯数字、纯标点、纯空白
    if (/^[\d\s\p{P}\p{S}]+$/u.test(trimmed)) return false;
    // 排除 emoji（包括组合 emoji）
    if (/[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Modifier_Base}\p{Emoji_Component}]/u.test(trimmed) && !/[a-zA-Z]/.test(trimmed)) return false;
    // 必须包含字母
    if (!/[a-zA-Z]/.test(trimmed)) return false;
    return true;
  }

  function translateText(text) {
    var trimmed = text.trim();
    if (!shouldTranslate(trimmed)) return text;

    // Exact match first
    if (TRANSLATIONS[trimmed]) {
      var translated = TRANSLATIONS[trimmed];
      var leading = text.match(/^\s*/)[0];
      var trailing = text.match(/\s*$/)[0];
      return leading + translated + trailing;
    }

    // Template-parameter match: "Found {{count}} results" → "找到 {{count}} 条结果"
    for (var en in TRANSLATIONS) {
      if (!Object.prototype.hasOwnProperty.call(TRANSLATIONS, en)) continue;
      var zh = TRANSLATIONS[en];
      if (en.indexOf("{{") !== -1) {
        var regexStr = escapeRegex(en).replace(/\{\{(\w+)\}\}/g, "([\\s\\S]+?)");
        var regex = new RegExp("^" + regexStr + "$");
        var match = trimmed.match(regex);
        if (match) {
          var result = zh;
          var paramNames = en.match(/\{\{(\w+)\}\}/g) || [];
          for (var i = 0; i < paramNames.length; i++) {
            var paramName = paramNames[i].replace(/[{}]/g, "");
            result = result.replace("{{" + paramName + "}}", match[i + 1]);
          }
          var leading = text.match(/^\s*/)[0];
          var trailing = text.match(/\s*$/)[0];
          return leading + result + trailing;
        }
      }
    }

    return text;
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, function (c) {
      return "\\" + c;
    });
  }

  // 按快捷键模式拆分文本，如 "New SessionCtrl+Shift+S" 拆分为 ["New Session", "Ctrl+Shift+S"]
  function splitTextByShortcut(text) {
    // 快捷键模式：Ctrl+, Alt+, Shift+, Cmd+, Meta+, F1-F12, Enter, Esc, Tab, Space, Delete, Backspace, Home, End, PageUp, PageDown, ArrowUp, ArrowDown, ArrowLeft, ArrowRight
    var shortcutPattern = /((?:Ctrl|Alt|Shift|Cmd|Meta|Option|Command)\+[\w]+|F\d{1,2}|Enter|Esc|Tab|Space|Delete|Backspace|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)/;
    var match = text.match(shortcutPattern);
    if (!match) return [text];
    var idx = match.index;
    var shortcut = match[0];
    // 拆分：快捷键前的文本 + 快捷键
    var before = text.substring(0, idx);
    var after = text.substring(idx + shortcut.length);
    var parts = [];
    if (before) parts.push(before);
    parts.push(shortcut);
    if (after) parts.push(after);
    return parts;
  }

  function processNode(node) {
    if (!node || replacedNodes.has(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      var original = node.textContent;
      if (!shouldTranslate(original)) return;
      // 尝试按快捷键模式拆分文本
      var parts = splitTextByShortcut(original);
      if (parts.length > 1) {
        var allTranslated = true;
        var translatedParts = [];
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          if (shouldTranslate(part)) {
            var t = translateText(part);
            if (t !== part) {
              translatedParts.push(t);
            } else {
              allTranslated = false;
              break;
            }
          } else {
            allTranslated = false;
            break;
          }
        }
        if (allTranslated && translatedParts.length > 0) {
          var result = translatedParts.join("");
          var leading = original.match(/^\s*/)[0];
          var trailing = original.match(/\s*$/)[0];
          replacedNodes.add(node);
          node.textContent = leading + result + trailing;
          setTimeout(function () {
            replacedNodes["delete"](node);
          }, 500);
          return;
        }
      }
      var translated = translateText(original);
      if (translated !== original) {
        replacedNodes.add(node);
        node.textContent = translated;
        setTimeout(function () {
          replacedNodes["delete"](node);
        }, 500);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (SKIP_TAGS.has(node.tagName)) return;
      // 翻译 title 属性
      if (node.title && shouldTranslate(node.title)) {
        var newTitle = translateText(node.title);
        if (newTitle !== node.title) node.title = newTitle;
      }
      // 翻译 aria-label 属性
      var aria = node.getAttribute("aria-label");
      if (aria && shouldTranslate(aria)) {
        var newAria = translateText(aria);
        if (newAria !== aria) node.setAttribute("aria-label", newAria);
      }
      // 翻译 placeholder 属性
      var ph = node.getAttribute("placeholder");
      if (ph && shouldTranslate(ph)) {
        var newPh = translateText(ph);
        if (newPh !== ph) node.setAttribute("placeholder", newPh);
      }
      // 翻译 data-tooltip 属性
      var tooltip = node.getAttribute("data-tooltip");
      if (tooltip && shouldTranslate(tooltip)) {
        var newTooltip = translateText(tooltip);
        if (newTooltip !== tooltip) node.setAttribute("data-tooltip", newTooltip);
      }
      // 翻译 data-title 属性
      var dataTitle = node.getAttribute("data-title");
      if (dataTitle && shouldTranslate(dataTitle)) {
        var newDataTitle = translateText(dataTitle);
        if (newDataTitle !== dataTitle) node.setAttribute("data-title", newDataTitle);
      }
      // 翻译 alt 属性
      var alt = node.getAttribute("alt");
      if (alt && shouldTranslate(alt)) {
        var newAlt = translateText(alt);
        if (newAlt !== alt) node.setAttribute("alt", newAlt);
      }
    }
  }

  function processTree(root) {
    try {
      var walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        null
      );
      var node;
      while ((node = walker.nextNode())) {
        processNode(node);
        // 递归扫描 Shadow DOM
        if (
          node.nodeType === Node.ELEMENT_NODE &&
          node.shadowRoot
        ) {
          processTree(node.shadowRoot);
        }
      }
    } catch (e) {
      console.warn("[opencode-zh] Error processing tree:", e);
    }
  }

  function startObserver() {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === "characterData") {
          processNode(m.target);
        } else if (m.type === "childList") {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var added = m.addedNodes[j];
            if (added.nodeType === Node.ELEMENT_NODE) {
              processTree(added);
              // 新增的元素如果带有 shadowRoot，也扫描其内部
              if (added.shadowRoot) {
                processTree(added.shadowRoot);
              }
            } else if (added.nodeType === Node.TEXT_NODE) {
              processNode(added);
            }
          }
        }
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    console.log("[opencode-zh] MutationObserver started");
  }

  function rescan() {
    if (document.body) {
      console.log("[opencode-zh] Delayed rescan triggered");
      processTree(document.body);
    }
  }

  function init() {
    setLocale();
    if (document.body) {
      processTree(document.body);
      startObserver();
    } else {
      document.addEventListener("DOMContentLoaded", function () {
        processTree(document.body);
        startObserver();
      });
    }
    // 延迟多次重扫描，捕获延迟渲染的组件（菜单、弹窗、虚拟 DOM 更新等）
    setTimeout(rescan, 500);
    setTimeout(rescan, 1500);
    setTimeout(rescan, 3000);
  }

  init();
  console.log("[opencode-zh] Injection script loaded");
})();
