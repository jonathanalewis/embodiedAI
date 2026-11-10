// Turns Galbot's raw streamed text into clean events for the browser.
//
// Galbot (see GALBOT_PROMPT) writes:
//   TO A                              <- who it is speaking to
//   SET label A | label B | rule      <- optional: add a standing instruction
//   CLEAR ALL  /  CLEAR 2             <- optional: remove instruction(s)
//   ...spoken reply...                <- streamed as "say" events
//   ===
//   ...same reply, other language...  <- streamed as "caption" events
//
// Text arrives in small random-sized chunks, so this works line by line and
// never sends anything that might turn out to be part of a header or "===".

export class GalbotParser {
  constructor({ asker, instructions, send }) {
    this.to = null; // "A" or "B"
    this.asker = asker;
    this.instructions = instructions; // the list sent by the browser (for CLEAR n)
    this.send = send;
    this.mode = "head"; // head -> say -> caption
    this.buf = ""; // text of the current, unfinished line
    this.lineStarted = false; // already sent part of the current line?
    this.saidAnything = false;
  }

  push(text) {
    this.buf += text;
    if (this.mode === "head") this.readHeader();
    if (this.mode !== "head") this.readBody();
  }

  end() {
    if (this.mode === "head") {
      // Never finished a header line: treat whatever we have as the reply.
      const rest = this.buf;
      this.buf = "";
      this.startBody();
      if (rest.trim() && !this.isHeaderLine(rest.trim())) this.emit(rest);
      return;
    }
    if (this.buf && this.buf.trim() !== "===") this.emit(this.buf);
    this.buf = "";
  }

  isHeaderLine(line) {
    return /^TO\s+[AB]\b/i.test(line) || /^SET\s/i.test(line) || /^CLEAR\b/i.test(line);
  }

  readHeader() {
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      if (!line) {
        this.buf = this.buf.slice(nl + 1);
        continue;
      }
      if (this.isHeaderLine(line)) {
        this.buf = this.buf.slice(nl + 1);
        this.handleHeader(line);
        continue;
      }
      // First non-header line: the spoken reply starts here.
      this.startBody();
      return;
    }
    // No complete line yet. If it can't become a header, start the reply now
    // so speech isn't delayed waiting for a newline.
    const start = this.buf.trimStart();
    if (start.length >= 6 && !/^(TO|SET|CLEAR)/i.test(start)) this.startBody();
  }

  handleHeader(line) {
    let m;
    if ((m = line.match(/^TO\s+([AB])\b/i))) {
      this.to = m[1].toUpperCase();
    } else if ((m = line.match(/^SET\s+(.+)$/i))) {
      const parts = m[1].split("|").map((s) => s.trim());
      const [labelA, labelB, rule] = parts;
      this.send({
        t: "instruction",
        action: "set",
        labels: { A: labelA || rule || "", B: labelB || labelA || "" },
        text: rule || parts.join(" "),
        from: this.asker,
      });
    } else if (/^CLEAR\s+ALL\b/i.test(line)) {
      this.send({ t: "instruction", action: "clear_all" });
    } else if ((m = line.match(/^CLEAR\s+(\d+)/i))) {
      const target = this.instructions[Number(m[1]) - 1];
      if (target) this.send({ t: "instruction", action: "clear", id: target.id });
    } else if (/^CLEAR\b/i.test(line)) {
      this.send({ t: "instruction", action: "clear_all" });
    }
  }

  startBody() {
    this.mode = "say";
    if (!this.to) this.to = this.asker;
    this.send({ t: "galbot_to", side: this.to });
  }

  readBody() {
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!this.lineStarted && line.trim() === "===") {
        this.mode = "caption";
        continue;
      }
      this.emit(line + "\n");
      this.lineStarted = false;
    }
    // Partial line: send it now unless it might still become "===".
    if (this.buf && !(this.lineStarted === false && /^\s*=*\s*$/.test(this.buf))) {
      this.emit(this.buf);
      this.buf = "";
      this.lineStarted = true;
    }
  }

  emit(text) {
    if (!text) return;
    if (this.mode === "caption") {
      this.send({ t: "caption", text });
    } else {
      if (!this.saidAnything && !text.trim()) return; // skip leading blank lines
      this.saidAnything = true;
      this.send({ t: "say", text });
    }
  }
}
