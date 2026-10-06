const WAProto = require('../../WAProto').proto;
const crypto = require('crypto');
const Utils_1 = require("../Utils");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const { PassThrough, Readable } = require("stream");

// ==========================================
// UTILITY FUNCTIONS & HELPERS (WATERMARK REMOVED)
// ==========================================

function extractIE(text, { extract = true, hyperlink = true, citation = true, latex = true } = {}) {
  if (!extract) {
    return { text, ie: [], inline_entities: [] };
  }
  const createIE = (type, ie) => {
    if (type == "hyperlink") {
      return {
        key: ie.key,
        metadata: {
          display_name: ie.text,
          is_trusted: ie.is_trusted,
          url: ie.url,
          __typename: "GenAIInlineLinkItem",
        },
      };
    }
    if (type == "citation") {
      return {
        key: ie.key,
        metadata: {
          reference_id: ie.reference_id,
          reference_url: ie.url,
          reference_title: ie.url,
          reference_display_name: ie.url,
          sources: [],
          __typename: "GenAISearchCitationItem",
        },
      };
    }
    if (type == "latex") {
      return {
        key: ie.key,
        metadata: {
          latex_expression: ie.text,
          latex_image: {
            url: ie.url,
            width: Number(ie.width) || 100,
            height: Number(ie.height) || 100,
          },
          font_height: Number(ie.font_height) || 83.333333333333,
          padding: Number(ie.padding) || 15,
          __typename: "GenAILatexItem",
        },
      };
    }
  };

  let ie = [];
  let inline_entities = [];
  let result = "";
  let last = 0;
  let citation_index = 1;
  let hyperlink_index = 0;
  let latex_index = 0;
  let stack = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] == "[" && text[i - 1] != "\\") {
      stack.push(i);
    } else if (text[i] == "]" && (text[i + 1] == "(" || text[i + 1] == "<")) {
      let start = stack.pop();
      if (start == null) continue;
      let open = text[i + 1];
      let close = open == "(" ? ")" : ">";
      let type = open == "(" ? "link" : "latex";
      let end = i + 2;
      let depth = 1;

      while (end < text.length && depth) {
        if (text[end] == open && text[end - 1] != "\\") depth++;
        else if (text[end] == close && text[end - 1] != "\\") depth--;
        end++;
      }
      if (depth) continue;

      let raw = text.slice(start + 1, i).trim();
      let url = text.slice(i + 2, end - 1).trim();
      let key, tag, data;

      if (type == "latex") {
        if (!latex) continue;
        let [txt = "", width = null, height = null, font_height = null, padding = null] = raw.split("|");
        key = `LATEX_${latex_index++}`;
        tag = `{{${key}}}${txt || "image"}{{/${key}}}`;
        data = {
          type: "latex",
          ie: { key, text: txt, url, width, height, font_height, padding },
        };
      } else if (raw) {
        if (!hyperlink) continue;
        const trusted = !url.startsWith("!");
        if (!trusted) url = url.slice(1);
        key = `HYPERLINK_${hyperlink_index++}`;
        tag = `{{${key}}}${url}{{/${key}}}`;
        data = {
          type: "hyperlink",
          ie: { key, text: raw, url, is_trusted: trusted },
        };
      } else {
        if (!citation) continue;
        key = `CITATION_${citation_index - 1}`;
        tag = `{{${key}}}${url}{{/${key}}}`;
        data = {
          type: "citation",
          ie: { reference_id: citation_index++, key, text: "", url },
        };
      }

      result += text.slice(last, start) + tag;
      last = end;
      ie.push(data);
      const entity = createIE(data.type, data.ie);
      if (entity) inline_entities.push(entity);
      i = end - 1;
    }
  }
  result += text.slice(last);
  return { text: result, ie, inline_entities };
}

async function waitAllPromises(input) {
  const isPromise = (v) => v && typeof v.then === "function";
  const isObject = (v) => v && typeof v === "object";
  const deep = async (v) => {
    if (isPromise(v)) return deep(await v);
    if (Array.isArray(v)) return Promise.all(v.map(deep));
    if (isObject(v)) {
      const entries = await Promise.all(
        Object.entries(v).map(async ([k, val]) => [k, await deep(val)])
      );
      return Object.fromEntries(entries);
    }
    return v;
  };
  return deep(await input);
}

const Toolkit = {
  async resize(buffer, x, y, fit = "cover") {
    return await sharp(buffer)
      .resize(x, y, {
        fit,
        position: "center",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  },
  async fetchBuffer(url, options = {}, { silent = true } = {}) {
    try {
      let response = await fetch(url, options);
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (silent) return Buffer.alloc(0);
      throw error;
    }
  },
  async toUrl(self, path, mediaType = "document") {
    if (!path) throw new Error("Url or buffer needed");
    const media = await self.utils.prepareWAMessageMedia(
      { [mediaType]: Buffer.isBuffer(path) ? path : { url: path } },
      {
        upload: self.waUploadToServer,
        jid: "@newsletter",
      }
    );
    return Object.values(media)[0]?.url;
  },
  async resolveMedia(self, media, mediaType = "image", { resolveUrl = false, resolveWAUrl = false, result = "url", resize = false, width = 300, height = 300 } = {}) {
    const isUrl = (str) => /^https?:\/\/.+/i.test(str);
    const isWAUrl = (str) => /^https?:\/\/[^/]*\.whatsapp\.net\//i.test(str);

    if (Array.isArray(media)) {
      return Promise.all(
        media.map((item) => Toolkit.resolveMedia(self, item, mediaType, { resolveUrl, resolveWAUrl, result, resize, width, height }))
      );
    }
    const originalIsBuffer = Buffer.isBuffer(media);
    if (typeof media === "string" && isUrl(media)) {
      if (isWAUrl(media)) {
        if (resolveWAUrl) {
          media = await Toolkit.fetchBuffer(media, {}, { silent: true });
        } else if (!resolveUrl) {
          if (result === "url") return media;
          media = await Toolkit.fetchBuffer(media, {}, { silent: true });
        }
      } else {
        if (!resolveUrl) {
          if (result === "url") return media;
          media = await Toolkit.fetchBuffer(media, {}, { silent: true });
        } else {
          media = await Toolkit.fetchBuffer(media, {}, { silent: true });
        }
      }
    }
    if (typeof media === "string" && !isUrl(media)) {
      media = Buffer.from(media, "base64");
    }
    if (!Buffer.isBuffer(media) || !media.length) return;
    if (resize && Buffer.isBuffer(media)) {
      media = await Toolkit.resize(media, width, height);
    }
    if (result === "buffer") return media;
    if (result === "base64") return media.toString("base64");
    return Toolkit.toUrl(self, media, mediaType);
  },
  getMp4Duration(buffer, { silent = true } = {}) {
    try {
      if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
        if (silent) return 0;
        throw new Error("Invalid buffer");
      }
      let offset = 0;
      while (offset < buffer.length - 8) {
        const size = buffer.readUInt32BE(offset);
        if (size < 8 || offset + size > buffer.length) {
          if (silent) return 0;
          throw new Error("Invalid atom size");
        }
        const type = buffer.toString("ascii", offset + 4, offset + 8);
        if (type === "moov") {
          let moovOffset = offset + 8;
          const moovEnd = offset + size;
          while (moovOffset < moovEnd - 8) {
            const childSize = buffer.readUInt32BE(moovOffset);
            if (childSize < 8 || moovOffset + childSize > moovEnd) {
              if (silent) return 0;
              throw new Error("Invalid child atom size");
            }
            const childType = buffer.toString("ascii", moovOffset + 4, moovOffset + 8);
            if (childType === "mvhd") {
              const version = buffer.readUInt8(moovOffset + 8);
              if (version === 0) {
                const timescale = buffer.readUInt32BE(moovOffset + 20);
                const duration = buffer.readUInt32BE(moovOffset + 24);
                if (!timescale) {
                  if (silent) return 0;
                  throw new Error("Invalid timescale");
                }
                return duration / timescale;
              }
              if (version === 1) {
                const timescale = buffer.readUInt32BE(moovOffset + 32);
                const duration = Number(buffer.readBigUInt64BE(moovOffset + 36));
                if (!timescale) {
                  if (silent) return 0;
                  throw new Error("Invalid timescale");
                }
                return duration / timescale;
              }
            }
            moovOffset += childSize;
          }
        }
        offset += size;
      }
      if (silent) return 0;
      throw new Error("No mvhd found!");
    } catch (err) {
      if (silent) return 0;
      throw err;
    }
  },
  getMp4Preview(videoBuffer, { time, result = "buffer", resize = true, width = 300, height = 300, silent = true } = {}) {
    return new Promise((resolve, reject) => {
      const fail = (err) => {
        if (silent) return resolve(result === "base64" ? "" : Buffer.alloc(0));
        return reject(err);
      };
      try {
        if (!Buffer.isBuffer(videoBuffer) || !videoBuffer.length) {
          return fail(new Error("videoBuffer tidak valid"));
        }
        const inputStream = new Readable({ read() {} });
        inputStream.push(videoBuffer);
        inputStream.push(null);
        const outputStream = new PassThrough();
        const chunks = [];
        outputStream.on("data", (chunk) => chunks.push(chunk));
        outputStream.on("end", async () => {
          try {
            let output = Buffer.concat(chunks);
            if (!output.length) return fail(new Error("Output kosong"));
            if (resize) output = await Toolkit.resize(output, width, height);
            return resolve(result === "base64" ? output.toString("base64") : output);
          } catch (err) { return fail(err); }
        });
        outputStream.on("error", fail);
        time ??= Math.min(Toolkit.getMp4Duration(videoBuffer) * 0.2, 10);
        ffmpeg(inputStream)
          .outputOptions([`-ss ${time}`, "-vframes 1", "-vcodec png", "-f image2pipe"])
          .on("error", (err) => fail(new Error(`ffmpeg error: ${err.message}`)))
          .pipe(outputStream, { end: true });
      } catch (err) { return fail(err); }
    });
  }
};

function tokenizer(code, lang = "javascript") {
  const keywordsMap = {
    javascript: new Set(["break", "case", "catch", "continue", "debugger", "delete", "do", "else", "finally", "for", "function", "if", "in", "instanceof", "new", "return", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "true", "false", "null", "undefined", "class", "const", "let", "super", "extends", "export", "import", "yield", "static", "constructor", "async", "await", "get", "set"]),
    typescript: new Set(["abstract", "any", "as", "asserts", "bigint", "boolean", "declare", "enum", "implements", "infer", "interface", "is", "keyof", "module", "namespace", "never", "readonly", "require", "number", "object", "override", "private", "protected", "public", "satisfies", "string", "symbol", "type", "unknown", "using", "from", "break", "case", "catch", "continue", "do", "else", "finally", "for", "function", "if", "new", "return", "switch", "this", "throw", "try", "var", "void", "while", "class", "const", "let", "extends", "import", "export", "async", "await"]),
    python: new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]),
    java: new Set(["abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native", "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void", "volatile", "while"]),
    golang: new Set(["break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var"]),
    c: new Set(["auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern", "float", "for", "goto", "if", "int", "long", "register", "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned", "void", "volatile", "while"]),
    cpp: new Set(["alignas", "alignof", "and", "auto", "bool", "break", "case", "catch", "class", "const", "constexpr", "continue", "delete", "do", "double", "else", "enum", "explicit", "export", "extern", "false", "float", "for", "friend", "if", "inline", "int", "long", "mutable", "namespace", "new", "noexcept", "nullptr", "operator", "private", "protected", "public", "return", "short", "signed", "sizeof", "static", "struct", "switch", "template", "this", "throw", "true", "try", "typedef", "typename", "union", "unsigned", "using", "virtual", "void", "while"]),
    php: new Set(["abstract", "and", "array", "as", "break", "callable", "case", "catch", "class", "clone", "const", "continue", "declare", "default", "do", "echo", "else", "elseif", "empty", "enddeclare", "endfor", "endforeach", "endif", "endswitch", "endwhile", "extends", "final", "finally", "fn", "for", "foreach", "function", "global", "goto", "if", "implements", "include", "include_once", "instanceof", "interface", "match", "namespace", "new", "null", "or", "private", "protected", "public", "require", "require_once", "return", "static", "switch", "throw", "trait", "try", "use", "var", "while", "yield"]),
    rust: new Set(["as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while"]),
    html: new Set(["html", "head", "body", "div", "span", "p", "a", "img", "video", "audio", "script", "style", "link", "meta", "form", "input", "button", "table", "tr", "td", "th", "ul", "ol", "li", "section", "article", "header", "footer", "nav", "main"]),
    bash: new Set(["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "in", "select", "until", "break", "continue", "return", "export", "readonly", "local", "declare"]),
    markdown: new Set(["#", "##", "###", "####", "#####", "######"])
  };

  if (!lang || lang === "txt" || lang === "text" || lang === "plaintext") {
    return {
      codeBlock: [{ codeContent: code, highlightType: 0 }],
      unified_codeBlock: [{ content: code, type: "DEFAULT" }]
    };
  }

  const TYPE_MAP = { 0: "DEFAULT", 1: "KEYWORD", 2: "METHOD", 3: "STR", 4: "NUMBER", 5: "COMMENT" };
  const keywords = keywordsMap[lang.toLowerCase()] || new Set();
  const tokens = [];
  let i = 0;

  const push = (content, type) => {
    if (!content) return;
    const last = tokens[tokens.length - 1];
    if (last && last.highlightType === type) {
      last.codeContent += content;
    } else {
      tokens.push({ codeContent: content, highlightType: type });
    }
  };

  const isIdentifier = (char) => {
    if (lang.toLowerCase() === "css") return /[a-zA-Z0-9_$-]/.test(char);
    if (lang.toLowerCase() === "html") return /[a-zA-Z0-9_$:-]/.test(char);
    return /[a-zA-Z0-9_$]/.test(char);
  };

  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) {
      let s = i;
      while (i < code.length && /\s/.test(code[i])) i++;
      push(code.slice(s, i), 0);
      continue;
    }
    if ((c === "/" && code[i + 1] === "/") || (c === "#" && ["python", "bash"].includes(lang))) {
      let s = i;
      while (i < code.length && code[i] !== "\n") i++;
      push(code.slice(s, i), 5);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let s = i;
      const q = c;
      i++;
      while (i < code.length) {
        if (code[i] === "\\" && i + 1 < code.length) i += 2;
        else if (code[i] === q) { i++; break; }
        else i++;
      }
      push(code.slice(s, i), 3);
      continue;
    }
    if (/[0-9]/.test(c)) {
      let s = i;
      while (i < code.length && /[0-9._]/.test(code[i])) i++;
      push(code.slice(s, i), 4);
      continue;
    }
    if (/[a-zA-Z_$]/.test(c)) {
      let s = i;
      while (i < code.length && isIdentifier(code[i])) i++;
      const word = code.slice(s, i);
      let type = 0;

      if (keywords.has(word)) type = 1;
      else if (lang === "css") {
        let j = i;
        while (j < code.length && /\s/.test(code[j])) j++;
        if (code[j] === ":") type = 1;
      } else if (lang === "html") {
        let p = s - 1;
        while (p >= 0 && /\s/.test(code[p])) p--;
        if (code[p] === "<" || (code[p] === "/" && code[p - 1] === "<")) type = 1;
      }
      if (type === 0) {
        let j = i;
        while (j < code.length && /\s/.test(code[j])) j++;
        if (code[j] === "(") type = 2;
      }
      push(word, type);
      continue;
    }
    push(c, 0);
    i++;
  }

  return {
    codeBlock: tokens,
    unified_codeBlock: tokens.map((t) => ({ content: t.codeContent, type: TYPE_MAP[t.highlightType] }))
  };
}

function toTableMetadata(arr, { hyperlink = true, citation = true, latex = true } = {}) {
  if (!Array.isArray(arr) || !arr.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) {
    throw new TypeError("Table must be a nested array of strings");
  }
  const [header, ...rows] = arr;
  const maxLen = Math.max(header.length, ...rows.map((r) => r.length));
  const normalize = (r) => [...r, ...Array(maxLen - r.length).fill("")];

  const unified_rows = [
    { is_header: true, cells: normalize(header) },
    ...rows.map((r) => ({ is_header: false, cells: normalize(r) })),
  ].map((row) => {
    const markdown_cells = row.cells.map((cell) => {
      const extracted = extractIE(cell, { hyperlink, citation, latex });
      return {
        text: extracted.text,
        ...(extracted.inline_entities.length ? { inline_entities: extracted.inline_entities } : {})
      };
    });
    return { ...row, ...(markdown_cells.some((c) => c.inline_entities?.length) ? { markdown_cells } : {}) };
  });

  const rowsMeta = unified_rows.map((r) => ({
    items: r.cells,
    ...(r.is_header ? { isHeading: true } : {})
  }));

  return { title: "", rows: rowsMeta, unified_rows };
}

function newLayout(name, data, extra = {}) {
  return {
    ...extra,
    view_model: {
      [Array.isArray(data) ? "primitives" : "primitive"]: data,
      __typename: `GenAI${name}LayoutViewModel`,
    }
  };
}

// ==========================================
// WAGURI CLASS
// ==========================================

class Waguri {
    constructor(utils, waUploadToServer, relayMessageFn) {
        this.utils = utils;
        this.relayMessage = relayMessageFn
        this.waUploadToServer = waUploadToServer;
        
        this.bail = {
            generateWAMessageContent: this.utils.generateWAMessageContent || Utils_1.generateWAMessageContent,
            generateMessageID: Utils_1.generateMessageID,
            getContentType: (msg) => Object.keys(msg.message || {})[0]
        };
    }

    detectType(content) {
        if (content.viewOnceMessage) return 'VIEW_ONCE';
        if (content.buttonMessage) return 'BUTTON_MSG';
        if (content.buttonV2Message) return 'BUTTON_V2_MSG';
        if (content.aiRichMessage) return 'AI_RICH_MSG';
        if (content.requestPaymentMessage) return 'PAYMENT';
        if (content.productMessage) return 'PRODUCT';
        if (content.interactiveMessage) return 'INTERACTIVE';
        if (content.albumMessage) return 'ALBUM';
        if (content.eventMessage) return 'EVENT';
        if (content.pollResultMessage) return 'POLL_RESULT';
        if (content.statusMentionMessage) return 'STATUS_MENTION';
        if (content.orderMessage) return 'ORDER';
        if (content.groupStatusMessage) return 'GROUP_STORY';
        if (content.carouselMessage || content.carousel) return 'CAROUSEL'; 
        return null;
    }

    async handleViewOnce(content, jid, quoted) {
        const data = content.viewOnceMessage;
        let innerMessage = {};

        if (data.image) {
            const payload = typeof data.image === 'object' && data.image.url 
                ? { image: { url: data.image.url } } 
                : { image: data.image };
            
            const media = await this.utils.prepareWAMessageMedia(payload, { upload: this.waUploadToServer });
            innerMessage = {
                imageMessage: {
                    ...media.imageMessage,
                    viewOnce: true
                }
            };
        } 
        else if (data.video) {
            const payload = typeof data.video === 'object' && data.video.url 
                ? { video: { url: data.video.url } } 
                : { video: data.video };

            const media = await this.utils.prepareWAMessageMedia(payload, { upload: this.waUploadToServer });
            innerMessage = {
                videoMessage: {
                    ...media.videoMessage,
                    viewOnce: true
                }
            };
        } 
        else if (data.message) {
            innerMessage = data.message;
        }

        const msg = await this.utils.generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: innerMessage
            }
        }, { quoted });

        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id
        });

        return msg;
    }

    async handleButtonMessage(content, jid, quoted) {
        const data = content.buttonMessage;
        const {
            title = "",
            subtitle = "",
            body = "",
            footer = "",
            buttons = [],
            params = {},
            media
        } = data;

        let mediaData = {};
        if (media) {
            mediaData = await this.utils.prepareWAMessageMedia(media, {
                upload: this.waUploadToServer
            });
        }

        const msg = await this.utils.generateWAMessageFromContent(jid, {
            interactiveMessage: {
                body: { text: body },
                footer: { text: footer },
                header: {
                    title,
                    subtitle,
                    hasMediaAttachment: !!media,
                    ...mediaData
                },
                nativeFlowMessage: {
                    messageParamsJson: JSON.stringify(params),
                    buttons: buttons.map(btn => ({
                        name: btn.name,
                        buttonParamsJson: typeof btn.params === 'string' ? btn.params : JSON.stringify(btn.params || {})
                    }))
                }
            }
        }, { quoted });

        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id,
            additionalNodes: [
                {
                    tag: "biz",
                    attrs: {},
                    content: [
                        {
                            tag: "interactive",
                            attrs: { type: "native_flow", v: "1" },
                            content: [
                                { tag: "native_flow", attrs: { v: "9", name: "mixed" } }
                            ]
                        }
                    ]
                }
            ]
        });
        return msg;
    }

    async handleButtonV2Message(content, jid, quoted) {
        const data = content.buttonV2Message;
        const {
            title = "",
            subtitle = "",
            body = "",
            footer = "",
            buttons = [],
            media,
            thumbnail
        } = data;

        let _thumbnail = null;
        if (thumbnail) {
            const buffer = Buffer.isBuffer(thumbnail)
                ? thumbnail
                : await Toolkit.fetchBuffer(thumbnail, {}, { silent: true });
            _thumbnail = await Toolkit.resize(buffer, 300, 300);
        }

        const msg = await this.utils.generateWAMessageFromContent(jid, {
            buttonsMessage: {
                contentText: body,
                footerText: footer,
                ...(media ? media : {
                    headerType: 6,
                    locationMessage: {
                        degreesLatitude: 0,
                        degreesLongitude: 0,
                        name: title,
                        address: subtitle,
                        jpegThumbnail: _thumbnail
                    }
                }),
                viewOnce: true,
                buttons: buttons.map((btn, idx) => ({
                    buttonId: btn.id || `btn-${idx}-${crypto.randomUUID()}`,
                    buttonText: { displayText: btn.displayText || btn.text || "" },
                    type: 1
                }))
            }
        }, { quoted });

        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id,
            additionalNodes: [
                {
                    tag: "biz",
                    attrs: {},
                    content: [
                        {
                            tag: "interactive",
                            attrs: { type: "native_flow", v: "1" },
                            content: [
                                { tag: "native_flow", attrs: { v: "9", name: "mixed" } }
                            ]
                        }
                    ]
                }
            ]
        });
        return msg;
    }

    async handleAIRichMessage(content, jid, quoted) {
        const data = content.aiRichMessage;
        const {
            title = "",
            footer = "",
            sections: rawSections = [],
            forwarded = true,
            notification = false,
            includesUnifiedResponse = true,
            includesSubmessages = true,
            contextInfo = {}
        } = data;

        const submessages = [];
        const sections = [];
        const richResponseSources = [];

        for (const item of rawSections) {
            if (item.type === 'text') {
                const { text: extractedText, inline_entities } = extractIE(item.text, {
                    hyperlink: item.hyperlink !== false,
                    citation: item.citation !== false,
                    latex: item.latex !== false,
                });
                submessages.push({
                    messageType: 2,
                    messageText: extractedText,
                });
                sections.push(
                    newLayout("Single", {
                        text: extractedText,
                        ...(inline_entities.length && { inline_entities }),
                        __typename: "GenAIMarkdownTextUXPrimitive",
                    })
                );
            }
            else if (item.type === 'code') {
                const meta = tokenizer(item.code, item.language || 'javascript');
                submessages.push({
                    messageType: 5,
                    codeMetadata: {
                        codeLanguage: item.language || 'javascript',
                        codeBlocks: meta.codeBlock,
                    },
                });
                sections.push(
                    newLayout("Single", {
                        language: item.language || 'javascript',
                        code_blocks: meta.unified_codeBlock,
                        __typename: "GenAICodeUXPrimitive",
                    })
                );
            }
            else if (item.type === 'table') {
                const meta = toTableMetadata(item.table, {
                    hyperlink: item.hyperlink !== false,
                    citation: item.citation !== false,
                    latex: item.latex !== false,
                });
                submessages.push({
                    messageType: 4,
                    tableMetadata: {
                        title: meta.title,
                        rows: meta.rows,
                    },
                });
                sections.push(
                    newLayout("Single", {
                        rows: meta.unified_rows,
                        __typename: "GenATableUXPrimitive",
                    })
                );
            }
            else if (item.type === 'source') {
                let sources = item.sources || [];
                if (sources.every((x) => typeof x === "string")) {
                    sources = [sources];
                }
                const source = await Promise.all(sources.map(async ([icon, url, text]) => ({
                    source_type: "THIRD_PARTY",
                    source_display_name: text ?? "",
                    source_subtitle: "AI",
                    source_url: url ?? "",
                    favicon: {
                        url: await Toolkit.resolveMedia(this, icon ?? "", "image"),
                        mime_type: "image/jpeg",
                        width: 16,
                        height: 16,
                    },
                })));
                sections.push(
                    newLayout("Single", {
                        sources: source,
                        __typename: "GenAISearchResultPrimitive",
                    })
                );
            }
            else if (item.type === 'reels') {
                let reelsItems = item.reels || [];
                if (!Array.isArray(reelsItems)) {
                    reelsItems = [reelsItems];
                }
                const reels = await Promise.all(reelsItems.map(async (reel) => ({
                    ...reel,
                    _avatar: await Toolkit.resolveMedia(
                        this,
                        reel.profileIconUrl ?? reel.profile_url ?? reel.profile ?? "",
                        "image"
                    ),
                    _thumbnail: await Toolkit.resolveMedia(
                        this,
                        reel.thumbnailUrl ?? reel.thumbnail ?? "",
                        "image"
                    ),
                })));

                submessages.push({
                    messageType: 9,
                    contentItemsMetadata: {
                        contentType: 1,
                        itemsMetadata: reels.map((reel) => ({
                            reelItem: {
                                title: reel.username ?? "",
                                profileIconUrl: reel._avatar,
                                thumbnailUrl: reel._thumbnail,
                                videoUrl: reel.videoUrl ?? reel.url ?? "",
                            },
                        })),
                    },
                });

                reels.forEach((reel, idx) => {
                    richResponseSources.push({
                        provider: "AI",
                        thumbnailCDNURL: reel._thumbnail,
                        sourceProviderURL: reel.videoUrl ?? reel.url ?? "",
                        sourceQuery: "",
                        faviconCDNURL: reel._avatar,
                        citationNumber: idx + 1,
                        sourceTitle: reel.username ?? "",
                    });
                });

                sections.push(
                    newLayout(
                        "HScroll",
                        reels.map((reel) => ({
                            reels_url: reel.videoUrl ?? reel.url ?? "",
                            thumbnail_url: reel._thumbnail,
                            creator: reel.username ?? reel.title ?? "",
                            avatar_url: reel._avatar,
                            reels_title: reel.reels_title ?? reel.title ?? "",
                            likes_count: reel.likes_count ?? reel.like ?? 0,
                            shares_count: reel.shares_count ?? reel.share ?? 0,
                            view_count: reel.view_count ?? reel.view ?? 0,
                            reel_source: reel.reel_source ?? reel.source ?? "IG",
                            is_verified: !!(reel.is_verified || reel.verified),
                            __typename: "GenAIReelPrimitive",
                        }))
                    )
                );
            }
            else if (item.type === 'image') {
                let imageUrl = item.image;
                const list = Array.isArray(imageUrl)
                  ? await Promise.all(imageUrl.map(async (v) => {
                      const url = await Toolkit.resolveMedia(this, v, "image", { resolveUrl: item.resolveUrl });
                      return {
                        imagePreviewUrl: url,
                        imageHighResUrl: url,
                        sourceUrl: url,
                      };
                    }))
                  : await (async () => {
                      const url = await Toolkit.resolveMedia(this, imageUrl, "image", { resolveUrl: item.resolveUrl });
                      return [
                        {
                          imagePreviewUrl: url,
                          imageHighResUrl: url,
                          sourceUrl: url,
                        },
                      ];
                    })();

                submessages.push({
                  messageType: 1,
                  gridImageMetadata: {
                    gridImageUrl: {
                      imagePreviewUrl: list[0]?.imagePreviewUrl,
                    },
                    imageUrls: list,
                  },
                });

                list.forEach(({ imagePreviewUrl }) => {
                  sections.push(
                    newLayout("Single", {
                      media: {
                        url: imagePreviewUrl,
                        mime_type: "image/png",
                      },
                      imagine_type: "IMAGE",
                      status: { status: "READY" },
                      __typename: "GenAIImaginePrimitive",
                    })
                  );
                });
            }
            else if (item.type === 'video') {
                const items = Array.isArray(item.video) ? item.video : [item.video];
                submessages.push({
                  messageType: 2,
                  messageText: "[ VIDEO_ERROR ]",
                });

                for (const vid of items) {
                  const isObj = vid && typeof vid === "object" && vid.url;
                  const url = isObj
                    ? await Toolkit.resolveMedia(this, vid.url ?? "", "video")
                    : await Toolkit.resolveMedia(this, vid, "video");

                  const autoFill = item.autoFill !== false;
                  const bufferPromise = autoFill ? await Toolkit.fetchBuffer(url) : null;

                  const file_length = isObj && vid.file_length != null
                      ? vid.file_length
                      : (autoFill && bufferPromise ? bufferPromise.length : 0);

                  const duration = isObj && vid.duration != null
                      ? vid.duration
                      : (autoFill && bufferPromise ? Toolkit.getMp4Duration(bufferPromise, { silent: true }) : 0);

                  const thumbnail = isObj && vid.thumbnail
                      ? await Toolkit.resolveMedia(this, vid.thumbnail, "image", {
                          result: "base64",
                          resize: true,
                          width: 300,
                          height: 300,
                        })
                      : (autoFill && bufferPromise
                          ? await Toolkit.getMp4Preview(bufferPromise, { time: 0, result: "base64" })
                          : null);

                  sections.push(
                    newLayout("Single", {
                      media: {
                        url,
                        mime_type: isObj ? (vid.mime_type ?? "video/mp4") : "video/mp4",
                        file_length,
                        duration,
                      },
                      imagine_type: "ANIMATE",
                      status: { status: "READY" },
                      thumbnail: {
                        raw_media: thumbnail,
                      },
                      __typename: "GenAIImaginePrimitive",
                    })
                  );
                }
            }
            else if (item.type === 'product') {
                submessages.push({
                  messageType: 2,
                  messageText: "[ PRODUCT_ERROR ]",
                });

                const items = Array.isArray(item.product) ? item.product : [item.product];
                const product = await Promise.all(items.map(async (prod) => ({
                  title: prod.title,
                  brand: prod.brand,
                  price: prod.price,
                  sale_price: prod.sale_price,
                  product_url: prod.product_url ?? prod.url,
                  image: {
                    url: await Toolkit.resolveMedia(this, prod.image_url ?? prod.image, "image"),
                  },
                  additional_images: [
                    {
                      url: await Toolkit.resolveMedia(this, prod.icon_url ?? prod.icon, "image"),
                    },
                  ],
                  __typename: "GenAIProductItemCardPrimitive",
                })));

                sections.push(
                  newLayout(
                    Array.isArray(item.product) ? "HScroll" : "Single",
                    Array.isArray(item.product) ? product : product[0]
                  )
                );
            }
            else if (item.type === 'post') {
                const posts = Array.isArray(item.post) ? item.post : [item.post];
                submessages.push({
                  messageType: 2,
                  messageText: "[ POST_ERROR ]",
                });

                const primitives = await Promise.all(posts.map(async (p) => ({
                  title: p.title ?? "",
                  subtitle: p.subtitle ?? "",
                  username: p.username ?? "",
                  profile_picture_url: await Toolkit.resolveMedia(
                    this,
                    p.profile_picture_url ?? p.profile_url ?? p.profile ?? "",
                    "image"
                  ),
                  is_verified: !!(p.is_verified || p.verified),
                  thumbnail_url: await Toolkit.resolveMedia(
                    this,
                    p.thumbnail_url ?? p.thumbnail ?? "",
                    "image"
                  ),
                  post_caption: p.post_caption ?? p.caption ?? "",
                  likes_count: p.likes_count ?? p.like ?? 0,
                  comments_count: p.comments_count ?? p.comment ?? 0,
                  shares_count: p.shares_count ?? p.share ?? 0,
                  post_url: p.post_url ?? p.url ?? "",
                  post_deeplink: p.post_deeplink ?? p.deeplink ?? "",
                  source_app: p.source_app || p.source || "INSTAGRAM",
                  footer_label: p.footer_label ?? p.footer ?? "",
                  footer_icon: await Toolkit.resolveMedia(
                    this,
                    p.footer_icon ?? p.icon ?? "",
                    "image"
                  ),
                  is_carousel: posts.length > 1,
                  orientation: p.orientation ?? "LANDSCAPE",
                  post_type: p.post_type ?? "VIDEO",
                  __typename: "GenAIPostPrimitive",
                })));

                sections.push(newLayout("HScroll", primitives));
            }
            else if (item.type === 'tip') {
                submessages.push({
                  messageType: 2,
                  messageText: item.text,
                });
                sections.push(
                  newLayout("Single", {
                    text: item.text,
                    __typename: "GenAIMetadataTextPrimitive",
                  })
                );
            }
            else if (item.type === 'suggest') {
                const suggest = Array.isArray(item.suggestion)
                  ? item.suggestion.map((text) => ({
                      prompt_text: text,
                      prompt_type: "SUGGESTED_PROMPT",
                      __typename: "GenAIFollowUpSuggestionPillPrimitive",
                    }))
                  : [
                      {
                        prompt_text: item.suggestion,
                        prompt_type: "SUGGESTED_PROMPT",
                        __typename: "GenAIFollowUpSuggestionPillPrimitive",
                      },
                    ];
                const layoutType = item.layout ?? (suggest.length === 1 ? "Single" : item.scroll !== false ? "HScroll" : "ActionRow");
                sections.push(
                  newLayout(layoutType, layoutType === "Single" ? suggest[0] : suggest, {
                    __typename: "GenAIUnifiedResponseSection",
                  })
                );
            }
        }

        if (footer) {
            sections.push(
              newLayout("Single", {
                text: footer,
                __typename: "GenAIMetadataTextPrimitive",
              })
            );
        }

        const resolvedSections = await waitAllPromises(sections);
        const resolvedSubmessages = await waitAllPromises(submessages);

        const forward = forwarded
          ? {
              forwardingScore: 1,
              isForwarded: true,
              forwardedAiBotMessageInfo: { botJid: "0@bot" },
              forwardOrigin: 4,
            }
          : {};

        const notif = notification
          ? {
              sessionTransparencyMetadata: {
                disclaimerText: title || "",
                hcaId: `hca_${Date.now()}`,
                sessionTransparencyType: 1,
              },
            }
          : {};

        const qObj = quoted
          ? {
              stanzaId: quoted?.key?.id || quoted?.id,
              participant: quoted?.key?.participant || quoted?.key?.remoteJid,
              quotedType: 0,
              quotedMessage: typeof quoted === "object" && quoted !== null ? (quoted.message ?? quoted) : undefined,
            }
          : {};

        const messageContent = {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            botMetadata: {
              messageDisclaimerText: title,
              richResponseSourcesMetadata: { sources: richResponseSources },
              ...notif,
            },
          },
          ...this._extraPayload,
          botForwardedMessage: {
            message: {
              richResponseMessage: {
                messageType: 1,
                submessages: includesSubmessages ? resolvedSubmessages : [],
                unifiedResponse: {
                  data: includesUnifiedResponse
                    ? Buffer.from(
                        JSON.stringify({
                          response_id: crypto.randomUUID(),
                          sections: resolvedSections,
                        }),
                      ).toString("base64")
                    : "",
                },
                contextInfo: {
                  ...forward,
                  ...qObj,
                  ...contextInfo,
                },
              },
            },
          },
        };

        const msg = await this.utils.generateWAMessageFromContent(jid, messageContent, { quoted });
        await this.relayMessage(jid, msg.message, {});
        return msg;
    }

    async handlePayment(content, quoted) {
        const data = content.requestPaymentMessage;
        let notes = {};

        if (data.sticker?.stickerMessage) {
            notes = {
                stickerMessage: {
                    ...data.sticker.stickerMessage,
                    contextInfo: {
                        stanzaId: quoted?.key?.id,
                        participant: quoted?.key?.participant || content.sender,
                        quotedMessage: quoted?.message
                    }
                }
            };
        } else if (data.note) {
            notes = {
                extendedTextMessage: {
                    text: data.note,
                    contextInfo: {
                        stanzaId: quoted?.key?.id,
                        participant: quoted?.key?.participant || content.sender,
                        quotedMessage: quoted?.message
                    }
                }
            };
        }

        return {
            requestPaymentMessage: WAProto.Message.RequestPaymentMessage.fromObject({
                expiryTimestamp: data.expiry || 0,
                amount1000: data.amount || 0,
                currencyCodeIso4217: data.currency || "IDR",
                requestFrom: data.from || "0@s.whatsapp.net",
                noteMessage: notes,
                background: data.background ?? {
                    id: "DEFAULT",
                    placeholderArgb: 0xFFF0F0F0
                }
            })
        };
    }
        
    async handleProduct(content, jid, quoted) {
        const {
            title, 
            description, 
            thumbnail,
            productId, 
            retailerId, 
            url, 
            body = "", 
            footer = "", 
            buttons = [],
            priceAmount1000 = null,
            currencyCode = "IDR"
        } = content.productMessage;

        let productImage;

        if (Buffer.isBuffer(thumbnail)) {
            const { imageMessage } = await this.utils.generateWAMessageContent(
                { image: thumbnail }, 
                { upload: this.waUploadToServer }
            );
            productImage = imageMessage;
        } else if (typeof thumbnail === 'object' && thumbnail.url) {
            const { imageMessage } = await this.utils.generateWAMessageContent(
                { image: { url: thumbnail.url }}, 
                { upload: this.waUploadToServer }
            );
            productImage = imageMessage;
        }

        return {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        body: { text: body },
                        footer: { text: footer },
                        header: {
                            title,
                            hasMediaAttachment: true,
                            productMessage: {
                                product: {
                                    productImage,
                                    productId,
                                    title,
                                    description,
                                    currencyCode,
                                    priceAmount1000,
                                    retailerId,
                                    url,
                                    productImageCount: 1
                                },
                                businessOwnerJid: "0@s.whatsapp.net"
                            }
                        },
                        nativeFlowMessage: { buttons }
                    }
                }
            }
        };
    }
    
    async handleInteractive(content, jid, quoted) {
        const {
            title,
            footer,
            thumbnail,
            image,
            video,
            document,
            mimetype,
            fileName,
            jpegThumbnail,
            contextInfo,
            externalAdReply,
            buttons = [],
            nativeFlowMessage,
            header
        } = content.interactiveMessage;

        let media = null;
        let mediaType = null;

        if (thumbnail) {
            media = await this.utils.prepareWAMessageMedia(
                { image: { url: thumbnail } },
                { upload: this.waUploadToServer }
            );
            mediaType = 'image';
        } else if (image) {
            if (typeof image === 'object' && image.url) {
                media = await this.utils.prepareWAMessageMedia(
                    { image: { url: image.url } },
                    { upload: this.waUploadToServer }
                );
            } else {
                media = await this.utils.prepareWAMessageMedia(
                    { image: image },
                    { upload: this.waUploadToServer }
                );
            }
            mediaType = 'image';
        } else if (video) {
            if (typeof video === 'object' && video.url) {
                media = await this.utils.prepareWAMessageMedia(
                    { video: { url: video.url } },
                    { upload: this.waUploadToServer }
                );
            } else {
                media = await this.utils.prepareWAMessageMedia(
                    { video: video },
                    { upload: this.waUploadToServer }
                );
            }
            mediaType = 'video';
        } else if (document) {
            let documentPayload = { 
                document: document 
            };
            if (jpegThumbnail) {
                if (typeof jpegThumbnail === 'object' && jpegThumbnail.url) {
                    documentPayload.jpegThumbnail = { url: jpegThumbnail.url };
                } else {
                    documentPayload.jpegThumbnail = jpegThumbnail;
                }
            }
            
            media = await this.utils.prepareWAMessageMedia(
                documentPayload,
                { upload: this.waUploadToServer }
            );
            if (fileName) {
                media.documentMessage.fileName = fileName;
            }
            if (mimetype) {
                media.documentMessage.mimetype = mimetype;
            }
            mediaType = 'document';
        }
        let interactiveMessage = {
            body: { text: title || "" },
            footer: { text: footer || "" }
        };
        if (buttons && buttons.length > 0) {
            interactiveMessage.nativeFlowMessage = {
                buttons: buttons
            };
            if (nativeFlowMessage) {
                interactiveMessage.nativeFlowMessage = {
                    ...interactiveMessage.nativeFlowMessage,
                    ...nativeFlowMessage
                };
            }
        } else if (nativeFlowMessage) {
            interactiveMessage.nativeFlowMessage = nativeFlowMessage;
        }
        
        if (media) {
            interactiveMessage.header = {
                title: header || "",
                hasMediaAttachment: true,
                ...media
            };
        } else {
            interactiveMessage.header = {
                title: header || "",        
                hasMediaAttachment: false
            };
        }
        
        let finalContextInfo = {};
        if (contextInfo) {
            finalContextInfo = {
                mentionedJid: contextInfo.mentionedJid || [],
                forwardingScore: contextInfo.forwardingScore || 0,
                isForwarded: contextInfo.isForwarded || false,
                ...contextInfo
            };
        }
        
        if (externalAdReply) {
            finalContextInfo.externalAdReply = {
                title: externalAdReply.title || "",
                body: externalAdReply.body || "",
                mediaType: externalAdReply.mediaType || 1,
                thumbnailUrl: externalAdReply.thumbnailUrl || "",
                mediaUrl: externalAdReply.mediaUrl || "",
                sourceUrl: externalAdReply.sourceUrl || "",
                showAdAttribution: externalAdReply.showAdAttribution || false,
                renderLargerThumbnail: externalAdReply.renderLargerThumbnail || false,
                ...externalAdReply
            };
        }
        
        if (Object.keys(finalContextInfo).length > 0) {
            interactiveMessage.contextInfo = finalContextInfo;
        }
        return {
            interactiveMessage: interactiveMessage
        };
    }
    
    async handleAlbum(content, jid, quoted) {
        const array = content.albumMessage;
        const album = await this.utils.generateWAMessageFromContent(jid, {
            messageContextInfo: {
                messageSecret: crypto.randomBytes(32),
            },
            albumMessage: {
                expectedImageCount: array.filter((a) => a.hasOwnProperty("image")).length,
                expectedVideoCount: array.filter((a) => a.hasOwnProperty("video")).length,
            },
        }, {
            userJid: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
            quoted,
            upload: this.waUploadToServer
        });
        
        await this.relayMessage(jid, album.message, {
            messageId: album.key.id,
        });
        
        for (let content of array) {
            const img = await this.utils.generateWAMessage(jid, content, {
                upload: this.waUploadToServer,
            });
            
            img.message.messageContextInfo = {
                messageSecret: crypto.randomBytes(32),
                messageAssociation: {
                    associationType: 1,
                    parentMessageKey: album.key,
                },    
                participant: "0@s.whatsapp.net",
                remoteJid: "status@broadcast",
                forwardingScore: 99999,
                isForwarded: true,
                mentionedJid: [jid],
                starred: true,
                labels: ["Y", "Important"],
                isHighlighted: true,
                businessMessageForwardInfo: {
                    businessOwnerJid: jid,
                },
                dataSharingContext: {
                    showMmDisclosure: true,
                },
            };

            img.message.forwardedNewsletterMessageInfo = {
                newsletterJid: "120363424933799317@newsletter",
                serverMessageId: 1,
                newsletterName: `WhatsApp`,
                contentType: 1,
                timestamp: new Date().toISOString(),
                senderName: "WhatsApp",
                content: "Text Message",
                priority: "high",
                status: "sent",
            };
            
            img.message.disappearingMode = {
                initiator: 3,
                trigger: 4,
                initiatorDeviceJid: jid,
                initiatedByExternalService: true,
                initiatedByUserDevice: true,
                initiatedBySystem: true,      
                initiatedByServer: true,
                initiatedByAdmin: true,
                initiatedByUser: true,
                initiatedByApp: true,
                initiatedByBot: true,
                initiatedByMe: true,
            };

            await this.relayMessage(jid, img.message, {
                messageId: img.key.id,
                quoted: {
                    key: {
                        remoteJid: album.key.remoteJid,
                        id: album.key.id,
                        fromMe: true,
                        participant: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
                    },
                    message: album.message,
                },
            });
        }
        return album;
    }   

    async handleEvent(content, jid, quoted) {
        const eventData = content.eventMessage;
        
        const msg = await this.utils.generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2,
                        messageSecret: crypto.randomBytes(32),
                        supportPayload: JSON.stringify({
                            version: 2,
                            is_ai_message: true,
                            should_show_system_message: true,
                            ticket_id: crypto.randomBytes(16).toString('hex')
                        })
                    },
                    eventMessage: {
                        contextInfo: {
                            mentionedJid: [jid],
                            participant: jid,
                            remoteJid: "status@broadcast",
                            forwardedNewsletterMessageInfo: {
                                newsletterName: "Invocation update Baileys",
                                newsletterJid: "120363424933799317@newsletter",
                                serverMessageId: 1
                            }
                        },
                        isCanceled: eventData.isCanceled || false,
                        name: eventData.name,
                        description: eventData.description,
                        location: eventData.location || {
                            degreesLatitude: 0,
                            degreesLongitude: 0,
                            name: "Location"
                        },
                        joinLink: eventData.joinLink || '',
                        startTime: typeof eventData.startTime === 'string' ? parseInt(eventData.startTime) : eventData.startTime || Date.now(),
                        endTime: typeof eventData.endTime === 'string' ? parseInt(eventData.endTime) : eventData.endTime || Date.now() + 3600000,
                        extraGuestsAllowed: eventData.extraGuestsAllowed !== false
                    }
                }
            }
        }, { quoted });
        
        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id
        });
        return msg;
    }
    
    async handlePollResult(content, jid, quoted) {
        const pollData = content.pollResultMessage;
    
        const msg = await this.utils.generateWAMessageFromContent(jid, {
            pollResultSnapshotMessage: {
                name: pollData.name,
                pollVotes: pollData.pollVotes.map(vote => ({
                    optionName: vote.optionName,
                    optionVoteCount: typeof vote.optionVoteCount === 'number' 
                    ? vote.optionVoteCount.toString() 
                    : vote.optionVoteCount
                }))
            }
        }, {
            userJid: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
            quoted
        });
    
        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id
        });

        return msg;
    }
    
    async handleStMention(content, jid, quoted) {
            const data = content.statusMentionMessage;
            let media = null;
            let mediaType = null;
            
            if (data.image) {
                if (typeof data.image === 'object' && data.image.url) {
                    media = await this.utils.prepareWAMessageMedia(
                        { image: { url: data.image.url } },
                        { upload: this.waUploadToServer }
                    );
                } else {
                    media = await this.utils.prepareWAMessageMedia(
                        { image: data.image },
                        { upload: this.waUploadToServer }
                    );
                }
                mediaType = 'image';
            } else if (data.video) {
                if (typeof data.video === 'object' && data.video.url) {
                    media = await this.utils.prepareWAMessageMedia(
                        { video: { url: data.video.url } },
                        { upload: this.waUploadToServer }
                    );
                } else {
                    media = await this.utils.prepareWAMessageMedia(
                        { video: data.video },
                        { upload: this.waUploadToServer }
                    );
                }
                mediaType = 'video';
            }
            const target = data.mentions;
            let msg = await this.relayMessage("status@broadcast", {
                ...media }, {
                  statusJidList: [data.mentions, this.user.id], 
                  additionalNodes: [{
                      tag: "meta",
                      attrs: {},
                      content: [
                        {
                          tag: "mentioned_users",
                          attrs: {},
                          content: [
                            {
                              tag: "to",
                              attrs: { jid: target },
                              content: undefined,
                            }
                          ]
                       }
                    ],
                  }]
                });
            
            let yesdata = await this.utils.generateWAMessageFromContent(jid, {
                statusMentionMessage: {
                    message: {
                        protocolMessage: {
                            messageId: msg.key,
                            type: "STATUS_MENTION_MESSAGE"
                        }
                    }
                }
            }, {
                additionalNodes: [
                    {
                        tag: "meta",
                        attrs: { "is_status_mention": true },
                        content: undefined
                    }
                ]
            });

            await this.relayMessage(jid, yesdata.message, {
                messageId: yesdata.key.id
            })
            return yesdata
        }
        
    async handleOrderMessage(content, jid, quoted) {
        const axios = require('axios');
        const orderData = content.orderMessage;
        let thumbnail = null;
        if (orderData.thumbnail) {
            if (Buffer.isBuffer(orderData.thumbnail)) {
                thumbnail = orderData.thumbnail;
            } else if (typeof orderData.thumbnail === "string") {
                try {
                    const res = await axios.get(orderData.thumbnail, {
                        responseType: "arraybuffer"
                    });
                    thumbnail = Buffer.from(res.data);
                } catch (e) {
                    console.error("Gagal download thumbnail:", e);
                    thumbnail = null;
                }
            }
        }

        const orderId = "ORDER_" + crypto.randomBytes(4).toString('hex').toUpperCase();
        const token = "TOKEN_" + crypto.randomBytes(4).toString('hex').toUpperCase();

        const heheheh = await this.utils.generateWAMessageFromContent(jid, {
            orderMessage: {
                orderId: orderId,
                thumbnail: thumbnail,
                itemCount: orderData.itemCount || 0,
                status: "ACCEPTED",
                surface: "CATALOG",
                message: orderData.message,
                orderTitle: orderData.orderTitle,
                sellerJid: "0@whatsapp.net",
                token: token,
                totalAmount1000: orderData.totalAmount1000 || 0,
                totalCurrencyCode: orderData.totalCurrencyCode || "IDR",
                messageVersion: 2
            }
        }, { quoted });

        await this.relayMessage(jid, heheheh.message, {});
        return heheheh;
    }

    async handleGroupStory(content, jid, quoted) {
        const storyData = content.groupStatusMessage;
        let waMsgContent;
        
        if (storyData.message) {
            waMsgContent = storyData;
        } else {
            if (typeof this.bail?.generateWAMessageContent === "function") {
                waMsgContent = await this.bail.generateWAMessageContent(storyData, {
                    upload: this.waUploadToServer
                });
            } else if (typeof this.utils?.generateWAMessageContent === "function") {
                waMsgContent = await this.utils.generateWAMessageContent(storyData, {
                    upload: this.waUploadToServer
                });
            } else if (typeof this.utils?.prepareMessageContent === "function") {
                waMsgContent = await this.utils.prepareMessageContent(storyData, {
                    upload: this.waUploadToServer
                });
            } else {
                waMsgContent = await Utils_1.generateWAMessageContent(storyData, {
                    upload: this.waUploadToServer
                });
            }
        }

        let msg = {
            message: {
                groupStatusMessageV2: {
                    message: waMsgContent.message || waMsgContent
                }
            }
        };

        return await this.relayMessage(jid, msg.message, {
            messageId: this.bail.generateMessageID()
        });
    }
    
    async handleCarousel(content, jid, quoted) {
        const root = content.carouselMessage || content.carousel || {};
        const { caption = "", footer = "", cards = [] } = root;

        const carouselCards = await Promise.all(
            cards.map(async (card) => {
                if (card.productTitle) {
                    return {
                        header: WAProto.Message.InteractiveMessage.Header.create({
                            title: card.headerTitle || "",
                            subtitle: card.headerSubtitle || "",
                            productMessage: {
                                product: {
                                    productImage: (
                                        await this.utils.prepareWAMessageMedia(
                                            { image: { url: card.imageUrl } },
                                            { upload: this.waUploadToServer }
                                        )
                                    ).imageMessage,
                                    productId: card.productId || "123456",
                                    title: card.productTitle,
                                    description: card.productDescription || "",
                                    currencyCode: card.currencyCode || "IDR",
                                    priceAmount1000: card.priceAmount1000 || "100000",
                                    retailerId: card.retailerId || "Retailer",
                                    url: card.url || "",
                                    productImageCount: 1
                                },
                                businessOwnerJid: card.businessOwnerJid || "0@s.whatsapp.net"
                            },
                            hasMediaAttachment: false
                        }),
                        body: WAProto.Message.InteractiveMessage.Body.create({
                            text: card.bodyText || ""
                        }),
                        footer: WAProto.Message.InteractiveMessage.Footer.create({
                            text: card.footerText || ""
                        }),
                        nativeFlowMessage: WAProto.Message.InteractiveMessage.NativeFlowMessage.create({
                            buttons: (card.buttons || []).map((btn) => ({
                                name: btn.name,
                                buttonParamsJson: JSON.stringify(btn.params || {})
                            }))
                        })
                    };
                } else {
                    return {
                        header: WAProto.Message.InteractiveMessage.Header.create({
                            title: card.headerTitle || "",
                            subtitle: card.headerSubtitle || "",
                            hasMediaAttachment: !!card.imageUrl,
                            ...(card.imageUrl
                                ? await this.utils.prepareWAMessageMedia(
                                      { image: { url: card.imageUrl } },
                                      { upload: this.waUploadToServer }
                                  )
                                : {}
                            )
                        }),
                        body: WAProto.Message.InteractiveMessage.Body.create({
                            text: card.bodyText || ""
                        }),
                        footer: WAProto.Message.InteractiveMessage.Footer.create({
                            text: card.footerText || ""
                        }),
                        nativeFlowMessage: WAProto.Message.InteractiveMessage.NativeFlowMessage.create({
                            buttons: (card.buttons || []).map((btn) => ({
                                name: btn.name,
                                buttonParamsJson: JSON.stringify(btn.params || {})
                            }))
                        })
                    };
                }
            })
        );

        const msg = await this.utils.generateWAMessageFromContent(
            jid,
            {
                viewOnceMessage: {
                    message: {
                        interactiveMessage: WAProto.Message.InteractiveMessage.create({
                            body: WAProto.Message.InteractiveMessage.Body.create({ text: caption }),
                            footer: WAProto.Message.InteractiveMessage.Footer.create({ text: footer }),
                            carouselMessage: WAProto.Message.InteractiveMessage.CarouselMessage.create({
                                cards: carouselCards,
                                messageVersion: 1
                            })
                        })
                    }
                }
            },
            { quoted }
        );

        await this.relayMessage(jid, msg.message, { messageId: msg.key.id });
        return msg;
    }
}

module.exports = Waguri;