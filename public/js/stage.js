import { ASSISTANT } from "./config.js";

// The display. Everything that draws on screen goes through here, so a
// different screen (Galbot's own display, a sign-language panel) can be
// plugged in later without touching the conversation logic.

export function createStage() {
  const $ = (sel) => document.querySelector(sel);
  const sides = {
    A: { root: $("#side-A"), lines: $("#side-A .lines"), lang: null },
    B: { root: $("#side-B"), lines: $("#side-B .lines"), lang: null },
  };
  const orb = $("#orb");
  const orbLabel = $("#orb-label");
  const chips = $("#chips");
  const notices = $("#notices");

  function scrollDown(side) {
    const el = sides[side].lines;
    el.scrollTop = el.scrollHeight;
  }

  // One caption line on one side.
  function line(side, kind, { label } = {}) {
    const s = sides[side];
    const el = document.createElement("div");
    el.className = `line line-${kind}`;
    if (label) {
      const tag = document.createElement("div");
      tag.className = "line-label";
      tag.textContent = label;
      el.append(tag);
    }
    const text = document.createElement("div");
    text.className = "line-text";
    text.lang = s.lang.code;
    text.dir = s.lang.rtl ? "rtl" : "ltr";
    const meta = document.createElement("div");
    meta.className = "line-meta";
    el.append(text, meta);
    s.lines.append(el);
    scrollDown(side);

    let content = "";
    const handle = {
      el,
      get text() {
        return content;
      },
      set(value) {
        content = value;
        text.textContent = value;
        el.classList.toggle("pending", !value.trim());
        scrollDown(side);
      },
      append(value) {
        handle.set(content + value);
      },
      pending() {
        el.classList.add("pending");
      },
      dim(reason) {
        el.classList.add("dimmed");
        if (reason) el.title = reason;
      },
      addMeta(html, cls = "") {
        const span = document.createElement("span");
        span.className = `meta-item ${cls}`;
        span.innerHTML = html;
        meta.append(span);
        scrollDown(side);
        return span;
      },
      clearMeta() {
        meta.replaceChildren();
      },
      addSource(url, title) {
        let host = url;
        try {
          host = new URL(url).hostname.replace(/^www\./, "");
        } catch {}
        const a = document.createElement("a");
        a.className = "source";
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = host;
        a.title = title || url;
        meta.append(a);
        scrollDown(side);
      },
      remove() {
        el.remove();
      },
    };
    return handle;
  }

  // Live captions while someone is still talking.
  const interimLines = { A: null, B: null };
  function interim(side, value) {
    if (!interimLines[side]) interimLines[side] = line(side, "self");
    interimLines[side].el.classList.add("interim");
    interimLines[side].set(value);
  }
  function takeInterim(side) {
    const h = interimLines[side];
    interimLines[side] = null;
    if (h) h.el.classList.remove("interim");
    return h;
  }
  function clearInterim(side) {
    const h = takeInterim(side);
    if (h) h.remove();
  }

  return {
    setLanguages(langs) {
      for (const side of ["A", "B"]) {
        const s = sides[side];
        s.lang = langs[side];
        s.root.querySelector(".side-lang").textContent = langs[side].native;
        s.root.lang = langs[side].code;
        const input = s.root.querySelector(".type-box input");
        input.lang = langs[side].code;
        input.dir = langs[side].rtl ? "rtl" : "ltr";
        s.lines.dir = langs[side].rtl ? "rtl" : "ltr";
        s.lines.replaceChildren();
      }
    },

    // Which side Galbot is currently listening to (null = nobody).
    // auto = the language detector is on, so anyone can speak at any time.
    setListening(side, langs, auto = false) {
      for (const k of ["A", "B"]) sides[k].root.classList.toggle("listening", !auto && k === side);
      if (auto) orbLabel.textContent = `${langs.A.native} ⇄ ${langs.B.native}`;
      else orbLabel.textContent = side ? `${side === "A" ? "←" : ""} ${langs[side].native} ${side === "B" ? "→" : ""}`.trim() : "";
      orbLabel.title = auto ? `Automatic: ${ASSISTANT.name} detects which language is spoken` : `${ASSISTANT.name} is listening for this language`;
    },

    // idle | listening | hearing | translating | thinking | searching | speaking | off
    setOrb(state) {
      orb.dataset.state = state;
    },

    line,
    interim,
    takeInterim,
    clearInterim,

    setChips(list, onRemove) {
      chips.replaceChildren(
        ...list.map((ins) => {
          const chip = document.createElement("button");
          chip.className = "chip";
          chip.title = `${ins.text}\n(tap to remove)`;
          const a = document.createElement("span");
          a.textContent = ins.labels.A;
          const b = document.createElement("span");
          b.textContent = ins.labels.B;
          const x = document.createElement("span");
          x.className = "chip-x";
          x.textContent = "×";
          chip.append(a, b, x);
          chip.addEventListener("click", () => onRemove(ins.id));
          return chip;
        })
      );
    },

    // Small messages under the orb (mic problems, missing voices...).
    notice(id, message) {
      let el = notices.querySelector(`[data-id="${id}"]`);
      if (!message) {
        el?.remove();
        return;
      }
      if (!el) {
        el = document.createElement("div");
        el.className = "notice";
        el.dataset.id = id;
        notices.append(el);
      }
      el.textContent = message;
    },
  };
}
