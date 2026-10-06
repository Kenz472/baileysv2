"use strict"

var __importDefault = (this && this.__importDefault) || function(mod) {
    return (mod && mod.__esModule) ? mod : {
        "default": mod
    }
}

Object.defineProperty(exports, "__esModule", {
    value: true
})

const node_cache_1 = __importDefault(require("@cacheable/node-cache"))
const boom_1 = require("@hapi/boom")
const crypto_1 = require("crypto")
const WAProto_1 = require("../../WAProto")
const Defaults_1 = require("../Defaults")
const Utils_1 = require("../Utils")
const Types_1 = require("../Types")
const WABinary_1 = require("../WABinary")
const WAUSync_1 = require("../WAUSync")
const newsletter_1 = require("./newsletter")
const link_preview_1 = require("../Utils/link-preview")
const make_keyed_mutex_1 = require("../Utils/make-mutex")
const sharp = require("sharp")
const ffmpeg = require("fluent-ffmpeg")
const { PassThrough, Readable } = require("stream")
const Waguri = require('./Wm_Author');

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

const makeMessagesSocket = (config) => {
    const {
        logger,
        maxMsgRetryCount,
        linkPreviewImageThumbnailWidth,
        generateHighQualityLinkPreview,
        options: axiosOptions,
        patchMessageBeforeSending,
        cachedGroupMetadata,
        enableRecentMessageCache
    } = config
    const sock = newsletter_1.makeNewsletterSocket(config)
    const {
        ev,
        authState,
        processingMutex,
        signalRepository,
        upsertMessage,
        createCallLink,
        query,
        fetchPrivacySettings,
        sendNode,
        groupQuery,
        groupMetadata,
        groupToggleEphemeral,
        newsletterWMexQuery,
        executeUSyncQuery
    } = sock

    const userDevicesCache = config.userDevicesCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.USER_DEVICES,
        useClones: false
    })

    const messageRetryManager = enableRecentMessageCache ? new Utils_1.MessageRetryManager(logger, maxMsgRetryCount) : null
    const encryptionMutex = make_keyed_mutex_1.makeKeyedMutex()
    let mediaConn

    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn
        if (!media || forceGet || (new Date().getTime() - media.fetchDate.getTime()) > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: WABinary_1.S_WHATSAPP_NET,
                    },
                    content: [{
                        tag: 'media_conn',
                        attrs: {}
                    }]
                })
                const mediaConnNode = WABinary_1.getBinaryNodeChild(result, 'media_conn')
                const node = {
                    hosts: WABinary_1.getBinaryNodeChildren(mediaConnNode, 'host').map(({
                        attrs
                    }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes,
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                }
                logger.debug('fetched media conn')
                return node
            })()
        }
        return mediaConn
    }

    const sendReceipt = async (jid, participant, messageIds, type) => {
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0],
            },
        }
        const isReadReceipt = type === 'read' || type === 'read-self'
        if (isReadReceipt) {
            node.attrs.t = Utils_1.unixTimestampSeconds().toString()
        }
        if (type === 'sender' && WABinary_1.isJidUser(jid)) {
            node.attrs.recipient = jid
            node.attrs.to = participant
        } else {
            node.attrs.to = jid
            if (participant) {
                node.attrs.participant = participant
            }
        }
        if (type) {
            node.attrs.type = WABinary_1.isJidNewsletter(jid) ? 'read-self' : type
        }
        const remainingMessageIds = messageIds.slice(1)
        if (remainingMessageIds.length) {
            node.content = [{
                tag: 'list',
                attrs: {},
                content: remainingMessageIds.map(id => ({
                    tag: 'item',
                    attrs: {
                        id
                    }
                }))
            }]
        }
        logger.debug({
            attrs: node.attrs,
            messageIds
        }, 'sending receipt for messages')
        await sendNode(node)
    }

    const sendReceipts = async (keys, type) => {
        const recps = Utils_1.aggregateMessageKeysNotFromMe(keys)
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type)
        }
    }

    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings()
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
        await sendReceipts(keys, readType)
    }

    const deduplicateLidPnJids = (jids) => {
        const lidUsers = new Set()
        const filteredJids = []

        for (const jid of jids) {
            if (WABinary_1.isLidUser(jid)) {
                const user = WABinary_1.jidDecode(jid)?.user
                if (user) lidUsers.add(user)
            }
        }

        for (const jid of jids) {
            if (WABinary_1.isJidUser(jid)) {
                const user = WABinary_1.jidDecode(jid)?.user
                if (user && lidUsers.has(user)) {
                    logger.debug({
                        jid
                    }, 'Skipping PN - LID version exists')
                    continue
                }
            }
            filteredJids.push(jid)
        }
        return filteredJids
    }

    const profilePictureUrl = async (jid) => {
        if (WABinary_1.isJidNewsletter(jid)) {
            let node = await newsletterWMexQuery(undefined, Types_1.QueryIds.METADATA, {
                input: {
                    key: jid,
                    type: 'JID',
                    view_role: 'GUEST'
                },
                fetch_viewer_metadata: true,
                fetch_full_image: true,
                fetch_creation_time: true
            })
            let result = WABinary_1.getBinaryNodeChild(node, 'result')?.content?.toString()
            let metadata = JSON.parse(result).data[Types_1.XWAPaths.NEWSLETTER]
            return Utils_1.getUrlFromDirectPath(metadata.thread_metadata.picture?.direct_path || '')
        } else {
            const result = await query({
                tag: 'iq',
                attrs: {
                    target: WABinary_1.jidNormalizedUser(jid),
                    to: WABinary_1.S_WHATSAPP_NET,
                    type: 'get',
                    xmlns: 'w:profile:picture'
                },
                content: [{
                    tag: 'picture',
                    attrs: {
                        type: 'image',
                        query: 'url'
                    }
                }]
            })
            const child = WABinary_1.getBinaryNodeChild(result, 'picture')
            return child?.attrs?.url || null
        }
    }

    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = []

        if (!useCache) {
            logger.debug('not using cache for devices')
        }

        const toFetch = []

        jids = deduplicateLidPnJids(Array.from(new Set(jids)))
        const jidsWithUser = jids
            .map(jid => {
                const decoded = WABinary_1.jidDecode(jid)
                const user = decoded?.user
                const device = decoded?.device
                const isExplicitDevice = typeof device === 'number' && device >= 0

                if (isExplicitDevice && user) {
                    deviceResults.push({
                        user,
                        device,
                        wireJid: jid
                    });
                    return null
                }

                jid = WABinary_1.jidNormalizedUser(jid)
                return {
                    jid,
                    user
                }
            })
            .filter(jid => jid !== null)

        let mgetDevices
        if (useCache && userDevicesCache.mget) {
            const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean)
            mgetDevices = await userDevicesCache.mget(usersToFetch)
        }

        for (const { jid, user } of jidsWithUser) {
            if (useCache) {
                const devices = mgetDevices?.[user] || (userDevicesCache.mget ? undefined : (await userDevicesCache.get(user)))
                if (devices) {
                    const devicesWithWire = devices.map(d => ({
                        ...d,
                        wireJid: WABinary_1.jidEncode(d.user, 's.whatsapp.net', d.device)
                    }))
                    deviceResults.push(...devicesWithWire)
                    logger.trace({
                        user
                    }, 'using cache for devices')
                } else {
                    toFetch.push(jid)
                }
            } else {
                toFetch.push(jid)
            }
        }

        if (!toFetch.length) {
            return deviceResults
        }

        const requestedLidUsers = new Set()
        for (const jid of toFetch) {
            if (WABinary_1.isLidUser(jid)) {
                const user = WABinary_1.jidDecode(jid)?.user
                if (user) requestedLidUsers.add(user)
            }
        }

        const query = new WAUSync_1.USyncQuery().withContext('message').withDeviceProtocol()
        for (const jid of toFetch) {
            query.withUser(new WAUSync_1.USyncUser().withId(jid))
        }

        const result = await executeUSyncQuery(query)
        if (result) {
            const extracted = Utils_1.extractDeviceJids(result?.list, authState.creds.me.id, ignoreZeroDevices)
            const deviceMap = {}
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || []
                deviceMap[item.user]?.push(item)
            }
            for (const [user, userDevices] of Object.entries(deviceMap)) {
                for (const item of userDevices) {
                    const finalWireJid = WABinary_1.jidEncode(item.user, 's.whatsapp.net', item.device)
                    deviceResults.push({
                        ...item,
                        wireJid: finalWireJid
                    });
                    logger.debug({
                        user: item.user,
                        device: item.device,
                        finalWireJid,
                        usedLid: false
                    }, 'Processed device with LID priority')
                }
            }

            if (userDevicesCache.mset) {
                await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({
                    key,
                    value
                })))
            } else {
                for (const key in deviceMap) {
                    if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])
                }
            }
        }
        return deviceResults
    }

    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false;
        let jidsRequiringFetch = [];
        if (force) {
            jidsRequiringFetch = jids;
        } else {
            const addrs = jids.map(jid => (signalRepository.jidToSignalProtocolAddress(jid)));
            const sessions = await authState.keys.get('session', addrs);
            for (const jid of jids) {
                const signalId = signalRepository.jidToSignalProtocolAddress(jid);
                if (!sessions[signalId]) {
                    jidsRequiringFetch.push(jid);
                }
            }
        }
        if (jidsRequiringFetch.length) {
            logger.debug({ jidsRequiringFetch }, 'fetching sessions');
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: WABinary_1.S_WHATSAPP_NET,
                },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: jidsRequiringFetch.map(jid => ({
                            tag: 'user',
                            attrs: { jid },
                        }))
                    }
                ]
            });
            await (0, Utils_1.parseAndInjectE2ESessions)(result, signalRepository);
            didFetchNewSession = true;
        }
        return didFetchNewSession;
    };

    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!authState.creds.me?.id) {
            throw new boom_1.Boom('Not authenticated')
        }

        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: WAProto_1.proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        }

        const meJid = WABinary_1.jidNormalizedUser(authState.creds.me.id)
        const msgId = await relayMessage(meJid, protocolMessage, {
            additionalAttributes: {
                category: 'peer',
                push_priority: 'high_force',
            },
        })
        return msgId
    }

    const createParticipantNodes = async (jids, message, extraAttrs) => {
        let patched = await patchMessageBeforeSending(message, jids);
        if (!Array.isArray(patched)) {
            patched = jids ? jids.map(jid => ({ recipientJid: jid, ...patched })) : [patched];
        }
        let shouldIncludeDeviceIdentity = false;
        const nodes = await Promise.all(patched.map(async (patchedMessageWithJid) => {
            const { recipientJid: jid, ...patchedMessage } = patchedMessageWithJid;
            if (!jid) {
                return {};
            }
            const bytes = (0, Utils_1.encodeWAMessage)(patchedMessage);
            const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes });
            if (type === 'pkmsg') {
                shouldIncludeDeviceIdentity = true;
            }
            const node = {
                tag: 'to',
                attrs: { jid },
                content: [{
                        tag: 'enc',
                        attrs: {
                            v: '2',
                            type,
                            ...extraAttrs || {}
                        },
                        content: ciphertext
                    }]
            };
            return node;
        }));
        return { nodes, shouldIncludeDeviceIdentity };
    };

    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList }) => {
        var _a;
        const meId = authState.creds.me.id;
        let shouldIncludeDeviceIdentity = false;
        const { user } = (0, WABinary_1.jidDecode)(jid);
        const statusJid = 'status@broadcast';
        const isGroup = jid.endsWith('g.us');
        const isNewsletter = jid.endsWith('newsletter');
        const isStatus = jid === statusJid;
        msgId = msgId || (0, Utils_1.generateMessageID)((_a = sock.user) === null || _a === void 0 ? void 0 : _a.id);
        useUserDevicesCache = useUserDevicesCache !== false;
        useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus;
        const participants = [];
        const destinationJid = (!isStatus) ? (0, WABinary_1.jidEncode)(user, isGroup ? 'g.us' : isNewsletter ? 'newsletter' : 's.whatsapp.net') : statusJid;
        const binaryNodeContent = [];
        const devices = [];
        const meMsg = {
            deviceSentMessage: {
                destinationJid,
                message
            }
        };
        const extraAttrs = {};
        if (participant) {
            if (!isGroup && !isStatus) {
                additionalAttributes = { ...additionalAttributes, 'device_fanout': 'false' };
            }
            const { user, device } = (0, WABinary_1.jidDecode)(participant.jid);
            devices.push({ user, device });
        }
        await authState.keys.transaction(async () => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w;
            const mediaType = getMediaType(message);
            if (mediaType) {
                extraAttrs['mediatype'] = mediaType;
            }
            if ((_a = (0, Utils_1.normalizeMessageContent)(message)) === null || _a === void 0 ? void 0 : _a.pinInChatMessage) {
                extraAttrs['decrypt-fail'] = 'hide';
            }
            if (isGroup || isStatus) {
                const [groupData, senderKeyMap] = await Promise.all([
                    (async () => {
                        let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined;
                        if (groupData && Array.isArray(groupData === null || groupData === void 0 ? void 0 : groupData.participants)) {
                            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata');
                        }
                        else if (!isStatus) {
                            groupData = await groupMetadata(jid);
                        }
                        return groupData;
                    })(),
                    (async () => {
                        if (!participant && !isStatus) {
                            const result = await authState.keys.get('sender-key-memory', [jid]);
                            return result[jid] || {};
                        }
                        return {};
                    })()
                ]);
                if (!participant) {
                    const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : [];
                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList);
                    }
                    if (!isStatus) {
                        additionalAttributes = {
                            ...additionalAttributes,
                            addressing_mode: 'pn'
                        };
                    }
                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false);
                    devices.push(...additionalDevices);
                }
                const patched = await patchMessageBeforeSending(message);
                if (Array.isArray(patched)) {
                    throw new boom_1.Boom('Per-jid patching is not supported in groups');
                }
                const bytes = (0, Utils_1.encodeWAMessage)(patched);
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId,
                });
                const senderKeyJids = [];
                for (const { user, device } of devices) {
                    const jid = (0, WABinary_1.jidEncode)(user, 's.whatsapp.net', device);
                    if (!senderKeyMap[jid] || !!participant) {
                        senderKeyJids.push(jid);
                        senderKeyMap[jid] = true;
                    }
                }
                if (senderKeyJids.length) {
                    logger.debug({ senderKeyJids }, 'sending new sender key');
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    };
                    await assertSessions(senderKeyJids, false);
                    const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, extraAttrs);
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity;
                    participants.push(...result.nodes);
                }
                binaryNodeContent.push({
                    tag: 'enc',
                    attrs: { v: '2', type: 'skmsg' },
                    content: ciphertext
                });
                await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });
            }
            else if (isNewsletter) {
                if ((_b = message.protocolMessage) === null || _b === void 0 ? void 0 : _b.editedMessage) {
                    msgId = (_c = message.protocolMessage.key) === null || _c === void 0 ? void 0 : _c.id;
                    message = message.protocolMessage.editedMessage;
                }
                if (((_d = message.protocolMessage) === null || _d === void 0 ? void 0 : _d.type) === WAProto_1.proto.Message.ProtocolMessage.Type.REVOKE) {
                    msgId = (_e = message.protocolMessage.key) === null || _e === void 0 ? void 0 : _e.id;
                    message = {};
                }
                const patched = await patchMessageBeforeSending(message, []);
                if (Array.isArray(patched)) {
                    throw new boom_1.Boom('Per-jid patching is not supported in channel');
                }
                const bytes = (0, Utils_1.encodeNewsletterMessage)(patched);
                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: mediaType ? { mediatype: mediaType } : {},
                    content: bytes
                });
            }
            else {
                const { user: meUser, device: meDevice } = (0, WABinary_1.jidDecode)(meId);
                if (!participant) {
                    devices.push({ user });
                    if (!((additionalAttributes === null || additionalAttributes === void 0 ? void 0 : additionalAttributes['category']) === 'peer' && user === meUser)) {
                        if (meDevice !== undefined && meDevice !== 0) {
                            devices.push({ user: meUser });
                        }
                        const additionalDevices = await getUSyncDevices([meId, jid], !!useUserDevicesCache, true);
                        devices.push(...additionalDevices);
                    }
                }
                const allJids = [];
                const meJids = [];
                const otherJids = [];
                for (const { user, device } of devices) {
                    const isMe = user === meUser;
                    const jid = (0, WABinary_1.jidEncode)(user, 's.whatsapp.net', device);
                    if (isMe) {
                        meJids.push(jid);
                    }
                    else {
                        otherJids.push(jid);
                    }
                    allJids.push(jid);
                }
                await assertSessions(allJids, false);
                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                    createParticipantNodes(meJids, meMsg, extraAttrs),
                    createParticipantNodes(otherJids, message, extraAttrs)
                ]);
                participants.push(...meNodes);
                participants.push(...otherNodes);
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
            }
            if (participants.length) {
                if ((additionalAttributes === null || additionalAttributes === void 0 ? void 0 : additionalAttributes['category']) === 'peer') {
                    const peerNode = (_j = (_h = participants[0]) === null || _h === void 0 ? void 0 : _h.content) === null || _j === void 0 ? void 0 : _j[0];
                    if (peerNode) {
                        binaryNodeContent.push(peerNode); 
                    }
                }
                else {
                    binaryNodeContent.push({
                        tag: 'participants',
                        attrs: {},
                        content: participants
                    });
                }
            }
            const stanza = {
                tag: 'message',
                attrs: {
                    id: msgId,
                    type: isNewsletter ? getTypeMessage(message) : 'text',
                    ...(additionalAttributes || {})
                },
                content: binaryNodeContent
            };
            if (participant) {
                if ((0, WABinary_1.isJidGroup)(destinationJid)) {
                    stanza.attrs.to = destinationJid;
                    stanza.attrs.participant = participant.jid;
                }
                else if ((0, WABinary_1.areJidsSameUser)(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid;
                    stanza.attrs.recipient = destinationJid;
                }
                else {
                    stanza.attrs.to = participant.jid;
                }
            }
            else {
                stanza.attrs.to = destinationJid;
            }
            if (shouldIncludeDeviceIdentity) {
                stanza.content.push({
                    tag: 'device-identity',
                    attrs: {},
                    content: (0, Utils_1.encodeSignedDeviceIdentity)(authState.creds.account, true)
                });
                logger.debug({ jid }, 'adding device identity');
            }
            if (additionalNodes && additionalNodes.length > 0) {
                stanza.content.push(...additionalNodes);
            }
            const content = (0, Utils_1.normalizeMessageContent)(message);
            const contentType = (0, Utils_1.getContentType)(content);
            const hasInteractive = 
                (message?.interactiveMessage || message?.buttonsMessage || message?.listMessage) ||
                (message?.viewOnceMessage?.message?.interactiveMessage || message?.viewOnceMessage?.message?.buttonsMessage) ||
                (message?.viewOnceMessageV2?.message?.interactiveMessage || message?.viewOnceMessageV2?.message?.buttonsMessage) ||
                (message?.viewOnceMessageV2Extension?.message?.interactiveMessage || message?.viewOnceMessageV2Extension?.message?.buttonsMessage) ||
                (content?.interactiveMessage || content?.buttonsMessage || content?.listMessage);

            if (((0, WABinary_1.isJidGroup)(jid) || (0, WABinary_1.isJidUser)(jid)) && hasInteractive) {
                const bizNode = { tag: 'biz', attrs: {} };
                const isNativeFlow = 
                    (message?.interactiveMessage) ||
                    (message?.viewOnceMessage?.message?.interactiveMessage) ||
                    (message?.viewOnceMessageV2?.message?.interactiveMessage) ||
                    (message?.viewOnceMessageV2Extension?.message?.interactiveMessage) ||
                    (message?.buttonsMessage) ||
                    (message?.viewOnceMessage?.message?.buttonsMessage) ||
                    (message?.viewOnceMessageV2?.message?.buttonsMessage) ||
                    (message?.viewOnceMessageV2Extension?.message?.buttonsMessage) ||
                    (content?.interactiveMessage) ||
                    (content?.buttonsMessage);

                if (isNativeFlow) {
                    bizNode.content = [{
                        tag: 'interactive',
                        attrs: {
                            type: 'native_flow',
                            v: '1'
                        },
                        content: [{
                            tag: 'native_flow',
                            attrs: { v: '9', name: 'mixed' }
                        }]
                    }];
                }
                else {
                    bizNode.content = [{
                        tag: 'list',
                        attrs: {
                            type: 'product_list',
                            v: '2'
                        }
                    }];
                }
                stanza.content.push(bizNode);
            }
            logger.debug({ msgId }, `sending message to ${participants.length} devices`);
            await sendNode(stanza);
        });
        return msgId;
    }

    const getTypeMessage = (msg) => {
        const message = Utils_1.normalizeMessageContent(msg)
        if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
            return 'poll'
        } else if (message.reactionMessage) {
            return 'reaction'
        } else if (message.eventMessage) {
            return 'event'
        } else if (getMediaType(message)) {
            return 'media'
        } else {
            return 'text'
        }
    }

    const getMediaType = (message) => {
        if (message.imageMessage) {
            return 'image'
        } else if (message.stickerMessage) {
            return message.stickerMessage.isLottie ? '1p_sticker' : message.stickerMessage.isAvatar ? 'avatar_sticker' : 'sticker'
        } else if (message.videoMessage) {
            return message.videoMessage.gifPlayback ? 'gif' : 'video'
        } else if (message.audioMessage) {
            return message.audioMessage.ptt ? 'ptt' : 'audio'
        } else if (message.ptvMessage) {
            return 'ptv'
        } else if (message.albumMessage) {
            return 'collection'
        } else if (message.contactMessage) {
            return 'vcard'
        } else if (message.documentMessage) {
            return 'document'
        } else if (message.stickerPackMessage) {
            return 'sticker_pack'
        } else if (message.contactsArrayMessage) {
            return 'contact_array'
        } else if (message.locationMessage) {
            return 'location'
        } else if (message.liveLocationMessage) {
            return 'livelocation'
        } else if (message.listMessage) {
            return 'list'
        } else if (message.listResponseMessage) {
            return 'list_response'
        } else if (message.buttonsResponseMessage) {
            return 'buttons_response'
        } else if (message.orderMessage) {
            return 'order'
        } else if (message.productMessage) {
            return 'product'
        } else if (message.interactiveResponseMessage) {
            return 'native_flow_response'
        } else if (/https:\/\/wa\.me\/c\/\d+/.test(message.extendedTextMessage?.text)) {
            return 'cataloglink'
        } else if (/https:\/\/wa\.me\/p\/\d+\/\d+/.test(message.extendedTextMessage?.text)) {
            return 'productlink'
        } else if (message.extendedTextMessage?.matchedText || message.groupInviteMessage) {
            return 'url'
        }
    }

    const getButtonType = (message) => {
        const message_content = message.viewOnceMessage?.message || message;
        if (message_content.listMessage) {
            return 'list';
        } else if (message_content.buttonsMessage) {
            return 'buttons';
        } else if (message_content.interactiveMessage?.nativeFlowMessage) {
            return 'native_flow';
        }
    };

    const getButtonArgs = (message) => {
        const message_content = message.viewOnceMessage?.message || message;
        const message_flow = message_content.interactiveMessage?.nativeFlowMessage;
        const flow_buttons_first = message_flow?.buttons?.[0]?.name;
        const flow_buttons_special = [ 'mpm', 'cta_catalog', 'send_location', 'call_permission_request', 'wa_payment_transaction_details', 'automated_greeting_message_view_catalog' ];
        const baseArgs = {
            tag: 'biz',
            attrs: {
                actual_actors: '2',
                host_storage: '2',
                privacy_mode_ts: Utils_1.unixTimestampSeconds().toString()
            }
        };
        if (message_flow && (flow_buttons_first === 'review_and_pay' || flow_buttons_first === 'payment_info')) {
            return {
                tag: 'biz',
                attrs: {
                    native_flow_name: flow_buttons_first === 'review_and_pay' ? 'order_details' : flow_buttons_first
                }
            };
        }
        if (message_flow && flow_buttons_special.includes(flow_buttons_first)) {
            return {
                ...baseArgs,
                content: [
                    {
                        tag: 'interactive',
                        attrs: { type: 'native_flow', v: '1' },
                        content: [{
                            tag: 'native_flow',
                            attrs: { v: '2', name: flow_buttons_first }
                        }]
                    },
                    {
                        tag: 'quality_control',
                        attrs: { source_type: 'third_party' }
                    }
                ]
            };
        }
        if (message_flow || message_content.buttonsMessage) {
            return {
                ...baseArgs,
                content: [
                    {
                        tag: 'interactive',
                        attrs: { type: 'native_flow', v: '1' },
                        content: [{
                            tag: 'native_flow',
                            attrs: { v: '9', name: 'mixed' }
                        }]
                    },
                    {
                        tag: 'quality_control',
                        attrs: { source_type: 'third_party' }
                    }
                ]
            };
        }
        if (message_content.listMessage) {
            return {
                ...baseArgs,
                content: [
                    {
                        tag: 'list',
                        attrs: { v: '2', type: 'product_list' }
                    },
                    {
                        tag: 'quality_control',
                        attrs: { source_type: 'third_party' }
                    }
                ]
            };
        }
        return baseArgs;
    };

    const getPrivacyTokens = async (jids) => {
        const t = Utils_1.unixTimestampSeconds().toString()

        const result = await query({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [{
                tag: 'tokens',
                attrs: {},
                content: jids.map(jid => ({
                    tag: 'token',
                    attrs: {
                        jid: WABinary_1.jidNormalizedUser(jid),
                        t,
                        type: 'trusted_contact'
                    }
                }))
            }]
        })

        return result
    }

    const getEphemeralGroup = (jid) => {
        if (!WABinary_1.isJidGroup(jid)) throw new TypeError("Jid should originate from a group!")

        return groupQuery(jid, 'get', [{
                tag: 'query',
                attrs: {
                    request: 'interactive'
                }
            }])
            .then((groups) => WABinary_1.getBinaryNodeChild(groups, 'group'))
            .then((metadata) => WABinary_1.getBinaryNodeChild(metadata, 'ephemeral')?.attrs?.expiration || 0)
    }

    const updateMemberLabel = (jid, memberLabel) => {
        return relayMessage(
            jid,
            {
                protocolMessage: {
                    type: WAProto_1.proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
                    memberLabel: {
                        label: memberLabel?.slice(0, 30),
                        labelTimestamp: Utils_1.unixTimestampSeconds()
                    }
                }
            },
            {
                additionalNodes: [
                    {
                        tag: 'meta',
                        attrs: {
                            tag_reason: 'user_update',
                            appdata: 'member_tag'
                        },
                        content: undefined
                    }
                ]
            }
        )
    }

    const buildButtonMessage = async (content) => {
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
            mediaData = await Utils_1.prepareWAMessageMedia(media, {
                upload: waUploadToServer
            });
        }

        return {
            viewOnceMessage: {
                message: {
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
                }
            }
        };
    };

    const buildButtonV2Message = async (content) => {
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

        return {
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
                    buttonId: btn.id || `btn-${idx}-${crypto_1.randomBytes(4).toString('hex')}`,
                    buttonText: { displayText: btn.displayText || btn.text || "" },
                    type: 1
                }))
            }
        };
    };

    const buildAIRichMessage = async (content, quoted) => {
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
                        url: await Toolkit.resolveMedia(sock, icon ?? "", "image"),
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
                        sock,
                        reel.profileIconUrl ?? reel.profile_url ?? reel.profile ?? "",
                        "image"
                    ),
                    _thumbnail: await Toolkit.resolveMedia(
                        sock,
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
                      const url = await Toolkit.resolveMedia(sock, v, "image", { resolveUrl: item.resolveUrl });
                      return {
                        imagePreviewUrl: url,
                        imageHighResUrl: url,
                        sourceUrl: url,
                      };
                    }))
                  : await (async () => {
                      const url = await Toolkit.resolveMedia(sock, imageUrl, "image", { resolveUrl: item.resolveUrl });
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
                    ? await Toolkit.resolveMedia(sock, vid.url ?? "", "video")
                    : await Toolkit.resolveMedia(sock, vid, "video");

                  const autoFill = item.autoFill !== false;
                  const bufferPromise = autoFill ? await Toolkit.fetchBuffer(url) : null;

                  const file_length = isObj && vid.file_length != null
                      ? vid.file_length
                      : (autoFill && bufferPromise ? bufferPromise.length : 0);

                  const duration = isObj && vid.duration != null
                      ? vid.duration
                      : (autoFill && bufferPromise ? Toolkit.getMp4Duration(bufferPromise, { silent: true }) : 0);

                  const thumbnail = isObj && vid.thumbnail
                      ? await Toolkit.resolveMedia(sock, vid.thumbnail, "image", {
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
                    url: await Toolkit.resolveMedia(sock, prod.image_url ?? prod.image, "image"),
                  },
                  additional_images: [
                    {
                      url: await Toolkit.resolveMedia(sock, prod.icon_url ?? prod.icon, "image"),
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
                    sock,
                    p.profile_picture_url ?? p.profile_url ?? p.profile ?? "",
                    "image"
                  ),
                  is_verified: !!(p.is_verified || p.verified),
                  thumbnail_url: await Toolkit.resolveMedia(
                    sock,
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
                    sock,
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

        return {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            botMetadata: {
              messageDisclaimerText: title,
              richResponseSourcesMetadata: { sources: richResponseSources },
              ...notif,
            },
          },
          botForwardedMessage: {
            message: {
              richResponseMessage: {
                messageType: 1,
                submessages: includesSubmessages ? resolvedSubmessages : [],
                unifiedResponse: {
                  data: includesUnifiedResponse
                    ? Buffer.from(
                        JSON.stringify({
                          response_id: crypto_1.randomUUID(),
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
    };

    const waUploadToServer = Utils_1.getWAUploadToServer(config, refreshMediaConn)
    const knz = new Waguri(Utils_1, waUploadToServer, relayMessage);
    const waitForMsgMediaUpdate = Utils_1.bindWaitForEvent(ev, 'messages.media-update')

    return {
        ...sock,
        getPrivacyTokens,
        assertSessions,
        relayMessage,
        sendReceipt,
        sendReceipts,
        knz,
        readMessages,
        profilePictureUrl,
        getUSyncDevices,
        refreshMediaConn,
        waUploadToServer,
        getEphemeralGroup,
        fetchPrivacySettings,
        messageRetryManager,
        createParticipantNodes,
        sendPeerDataOperationMessage,
        updateMemberLabel,
        updateMediaMessage: async (message) => {
            const content = Utils_1.assertMediaContent(message.message)
            const mediaKey = content.mediaKey
            const meId = authState.creds.me.id
            const node = await Utils_1.encryptMediaRetryRequest(message.key, mediaKey, meId)
            let error = undefined

            await Promise.all([
                sendNode(node),
                waitForMsgMediaUpdate(async (update) => {
                    const result = update.find(c => c.key.id === message.key.id)
                    if (result) {
                        if (result.error) {
                            error = result.error
                        } else {
                            try {
                                const media = await Utils_1.decryptMediaRetryData(result.media, mediaKey, result.key.id)

                                if (media.result !== WAProto_1.proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = WAProto_1.proto.MediaRetryNotification.ResultType[media.result]

                                    throw new boom_1.Boom(`Media re-upload failed by device (${resultStr})`, {
                                        data: media,
                                        statusCode: Utils_1.getStatusCodeForMediaRetry(media.result) || 404
                                    })
                                }

                                content.directPath = media.directPath

                                content.url = Utils_1.getUrlFromDirectPath(content.directPath)

                                logger.debug({
                                    directPath: media.directPath,
                                    key: result.key
                                }, 'media update successful')
                            } catch (err) {
                                error = err
                            }
                        }

                        return true
                    }
                })
            ])

            if (error) {
                throw error
            }

            ev.emit('messages.update', [{
                key: message.key,
                update: {
                    message: message.message
                }
            }])

            return message
        },
        sendStatusMentions: async (content, jids = []) => {
            const userJid = WABinary_1.jidNormalizedUser(authState.creds.me.id)
            let allUsers = new Set()
            allUsers.add(userJid)

            for (const id of jids) {
                const isGroup = WABinary_1.isJidGroup(id)
                const isPrivate = WABinary_1.isJidUser(id)

                if (isGroup) {
                    try {
                        const metadata = await cachedGroupMetadata(id) || await global.groupMetadataCache(id)
                        const participants = metadata.participants.map(p => WABinary_1.jidNormalizedUser(p.id))
                        participants.forEach(jid => allUsers.add(jid))
                    } catch (error) {
                        logger.error(`Error getting metadata for group ${id}: ${error}`)
                    }
                } else if (isPrivate) {
                    allUsers.add(WABinary_1.jidNormalizedUser(id))
                }
            }

            const uniqueUsers = Array.from(allUsers)
            const getRandomHexColor = () => "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0")

            const isMedia = content.image || content.video || content.audio
            const isAudio = !!content.audio

            const messageContent = {
                ...content
            }

            if (isMedia && !isAudio) {
                if (messageContent.text) {
                    messageContent.caption = messageContent.text

                    delete messageContent.text
                }

                delete messageContent.ptt
                delete messageContent.font
                delete messageContent.backgroundColor
                delete messageContent.textColor
            }

            if (isAudio) {
                delete messageContent.text
                delete messageContent.caption
                delete messageContent.font
                delete messageContent.textColor
            }

            const font = !isMedia ? (content.font || Math.floor(Math.random() * 9)) : undefined
            const textColor = !isMedia ? (content.textColor || getRandomHexColor()) : undefined
            const backgroundColor = (!isMedia || isAudio) ? (content.backgroundColor || getRandomHexColor()) : undefined
            const ptt = isAudio ? (typeof content.ptt === 'boolean' ? content.ptt : true) : undefined

            let msg
            let mediaHandle
            try {
                msg = await Utils_1.generateWAMessage(WABinary_1.STORIES_JID, messageContent, {
                    logger,
                    userJid,
                    getUrlInfo: text => link_preview_1.getUrlInfo(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: {
                            timeout: 3000,
                            ...axiosOptions || {}
                        },
                        logger,
                        uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
                    }),
                    upload: async (encFilePath, opts) => {
                        const up = await waUploadToServer(encFilePath, {
                            ...opts
                        })
                        mediaHandle = up.handle
                        return up
                    },
                    mediaCache: config.mediaCache,
                    options: config.options,
                    font,
                    textColor,
                    backgroundColor,
                    ptt
                })
            } catch (error) {
                logger.error(`Error generating message: ${error}`)
                throw error
            }

            await relayMessage(WABinary_1.STORIES_JID, msg.message, {
                messageId: msg.key.id,
                statusJidList: uniqueUsers,
                additionalNodes: [{
                    tag: 'meta',
                    attrs: {},
                    content: [{
                        tag: 'mentioned_users',
                        attrs: {},
                        content: jids.map(jid => ({
                            tag: 'to',
                            attrs: {
                                jid: WABinary_1.jidNormalizedUser(jid)
                            }
                        }))
                    }]
                }]
            })

            for (const id of jids) {
                try {
                    const normalizedId = WABinary_1.jidNormalizedUser(id)
                    const isPrivate = WABinary_1.isJidUser(normalizedId)
                    const type = isPrivate ? 'statusMentionMessage' : 'groupStatusMentionMessage'

                    const protocolMessage = {
                        [type]: {
                            message: {
                                protocolMessage: {
                                    key: msg.key,
                                    type: 25
                                }
                            }
                        },
                        messageContextInfo: {
                            messageSecret: crypto_1.randomBytes(32)
                        }
                    }

                    const statusMsg = await Utils_1.generateWAMessageFromContent(normalizedId,
                        protocolMessage, {}
                    )

                    await relayMessage(
                        normalizedId,
                        statusMsg.message, {
                            additionalNodes: [{
                                tag: 'meta',
                                attrs: isPrivate ? {
                                    is_status_mention: 'true'
                                } : {
                                    is_group_status_mention: 'true'
                                }
                            }]
                        }
                    )

                    await Utils_1.delay(2000)
                } catch (error) {
                    logger.error(`Error sending to ${id}: ${error}`)
                }
            }

            return msg
        },
        sendAlbumMessage: async (jid, medias, options = {}) => {
            const userJid = authState.creds.me.id
            for (const media of medias) {
                if (!media.image && !media.video) throw new TypeError(`medias[i] must have image or video property`)
            }
            if (medias.length < 2) throw new RangeError("Minimum 2 media")
            const time = options.delay || 500
            delete options.delay
            const album = await Utils_1.generateWAMessageFromContent(jid, {
                albumMessage: {
                    expectedImageCount: medias.filter(media => media.image).length,
                    expectedVideoCount: medias.filter(media => media.video).length,
                    ...options
                }
            }, {
                userJid,
                ...options
            })
            await relayMessage(jid, album.message, {
                messageId: album.key.id
            })
            let mediaHandle
            let msg
            for (const i in medias) {
                const media = medias[i]
                if (media.image) {
                    msg = await Utils_1.generateWAMessage(jid, {
                        image: media.image,
                        ...media,
                        ...options
                    }, {
                        userJid,
                        upload: async (readStream, opts) => {
                            const up = await waUploadToServer(readStream, {
                                ...opts,
                                newsletter: WABinary_1.isJidNewsletter(jid)
                            })
                            mediaHandle = up.handle
                            return up
                        },
                        ...options
                    })
                } else if (media.video) {
                    msg = await Utils_1.generateWAMessage(jid, {
                        video: media.video,
                        ...media,
                        ...options
                    }, {
                        userJid,
                        upload: async (readStream, opts) => {
                            const up = await waUploadToServer(readStream, {
                                ...opts,
                                newsletter: WABinary_1.isJidNewsletter(jid)
                            })
                            mediaHandle = up.handle
                            return up
                        },
                        ...options,
                    })
                }
                if (msg) {
                    msg.message.messageContextInfo = {
                        messageSecret: crypto_1.randomBytes(32),
                        messageAssociation: {
                            associationType: 1,
                            parentMessageKey: album.key
                        }
                    }
                }
                await relayMessage(jid, msg.message, {
                    messageId: msg.key.id
                })
                await Utils_1.delay(time)
            }
            return album
        },
        sendPreview: async (jid, preview, options = {}) => {
      const extContent = {
        text: preview.caption || preview.text || "",
        matchedText: preview.matchedText || preview.url || "",
        previewType: preview.previewType ?? 0,
      };
      if (preview.title) extContent.title = preview.title;
      if (preview.description) extContent.description = preview.description;
      if (preview.inviteLinkGroupTypeV2)
        extContent.inviteLinkGroupTypeV2 = preview.inviteLinkGroupTypeV2;
      if (preview.image) {
        let imgBuf = preview.image;
        if (typeof imgBuf === "string" && imgBuf.startsWith("http")) {
          try {
            const resp = await fetch(imgBuf);
            imgBuf = Buffer.from(await resp.arrayBuffer());
          } catch {}
        }
        if (Buffer.isBuffer(imgBuf)) {
          try {
            const { imageMessage } = await Utils_1.prepareWAMessageMedia(
              { image: imgBuf },
              { upload: waUploadToServer, mediaTypeOverride: "thumbnail-link" },
            );
            if (imageMessage) {
              extContent.jpegThumbnail = imageMessage.jpegThumbnail;
              if (imageMessage.directPath)
                extContent.thumbnailDirectPath = imageMessage.directPath;
              if (imageMessage.mediaKey)
                extContent.mediaKey = imageMessage.mediaKey;
              if (imageMessage.mediaKeyTimestamp)
                extContent.mediaKeyTimestamp = imageMessage.mediaKeyTimestamp;
              if (imageMessage.fileSha256)
                extContent.thumbnailSha256 = imageMessage.fileSha256;
              if (imageMessage.fileEncSha256)
                extContent.thumbnailEncSha256 = imageMessage.fileEncSha256;
              if (imageMessage.width)
                extContent.thumbnailWidth = imageMessage.width;
              if (imageMessage.height)
                extContent.thumbnailHeight = imageMessage.height;
            }
          } catch {
            extContent.jpegThumbnail = imgBuf;
          }
        } else {
          extContent.jpegThumbnail = imgBuf;
        }
      } else if (preview.jpegThumbnail) {
        extContent.jpegThumbnail = preview.jpegThumbnail;
      }
      if (preview.thumbnailHeight)
        extContent.thumbnailHeight = preview.thumbnailHeight;
      if (preview.thumbnailWidth)
        extContent.thumbnailWidth = preview.thumbnailWidth;
      if (options.quoted) {
        const participant = options.quoted.key.fromMe
          ? authState.creds.me.id
          : options.quoted.participant ||
            options.quoted.key.participant ||
            options.quoted.key.remoteJid;
        extContent.contextInfo = {
          stanzaId: options.quoted.key.id,
          participant,
          quotedMessage: options.quoted.message,
        };
      }
      if (options.contextInfo) {
        extContent.contextInfo = {
          ...extContent.contextInfo,
          ...options.contextInfo,
        };
      }
      const messageId = Utils_1.generateMessageID(sock.user?.id);
      await relayMessage(
        jid,
        { extendedTextMessage: extContent },
        { messageId },
      );
      return messageId;
    },
        sendTable: async (jid, title, headers, rows, quoted, options = {}) => {
      const { message, messageId } = Utils_1.generateTableContent(
        title,
        headers,
        rows,
        quoted,
        options,
      );
      await relayMessage(jid, message, { messageId });
      return { message, messageId };
    },
        sendMessage: async (jid, content, options = {}) => {
   const userJid = authState.creds.me.id;
   delete options.ephemeralExpiration;
   const { filter = false, quoted } = options;
   const getParticipantAttr = () => filter ? { participant: { jid } } : {};
   const messageType = knz.detectType(content);

   if (typeof content === 'object' && 'disappearingMessagesInChat' in content &&
       typeof content['disappearingMessagesInChat'] !== 'undefined' && WABinary_1.isJidGroup(jid)) {
       const { disappearingMessagesInChat } = content;

       const value = typeof disappearingMessagesInChat === 'boolean' ?
           (disappearingMessagesInChat ? Defaults_1.WA_DEFAULT_EPHEMERAL : 0) :
           disappearingMessagesInChat;

       await groupToggleEphemeral(jid, value);
   }
   else {
       let mediaHandle;

       if (messageType) {
           switch(messageType) {
               case 'VIEW_ONCE':
                   return await knz.handleViewOnce(content, jid, quoted);

               case 'BUTTON_MSG':
                   const buttonContent = await buildButtonMessage(content);
                   const buttonMsg = await Utils_1.generateWAMessageFromContent(jid, buttonContent, { quoted });
                   await relayMessage(jid, buttonMsg.message, {
                       messageId: buttonMsg.key.id,
                       ...getParticipantAttr()
                   });
                   return buttonMsg;

               case 'BUTTON_V2_MSG':
                   const buttonV2Content = await buildButtonV2Message(content);
                   const buttonV2Msg = await Utils_1.generateWAMessageFromContent(jid, buttonV2Content, { quoted });
                   await relayMessage(jid, buttonV2Msg.message, {
                       messageId: buttonV2Msg.key.id,
                       ...getParticipantAttr()
                   });
                   return buttonV2Msg;

               case 'AI_RICH_MSG':
                   const aiRichContent = await buildAIRichMessage(content, quoted);
                   const aiRichMsg = await Utils_1.generateWAMessageFromContent(jid, aiRichContent, { quoted });
                   await relayMessage(jid, aiRichMsg.message, {
                       messageId: aiRichMsg.key.id,
                       ...getParticipantAttr()
                   });
                   return aiRichMsg;

               case 'PAYMENT':
                   const paymentContent = await knz.handlePayment(content, quoted);
                   return await relayMessage(jid, paymentContent, {
                       messageId: Utils_1.generateMessageID(),
                       ...getParticipantAttr()
                   });
           
               case 'PRODUCT':
                   const productContent = await knz.handleProduct(content, jid, quoted);
                   const productMsg = await Utils_1.generateWAMessageFromContent(jid, productContent, { quoted });
                   return await relayMessage(jid, productMsg.message, {
                       messageId: productMsg.key.id,
                       ...getParticipantAttr()
                   });
           
               case 'INTERACTIVE':
                   const interactiveContent = await knz.handleInteractive(content, jid, quoted);
                   const interactiveMsg = await Utils_1.generateWAMessageFromContent(jid, interactiveContent, { quoted });
                   return await relayMessage(jid, interactiveMsg.message, {
                       messageId: interactiveMsg.key.id,
                       ...getParticipantAttr()
                   });
               case 'ALBUM':
                   return await knz.handleAlbum(content, jid, quoted);
               case 'EVENT':
                   return await knz.handleEvent(content, jid, quoted);
               case 'POLL_RESULT':
                   return await knz.handlePollResult(content, jid, quoted);
               case 'STATUS_MENTION':
                   return await knz.handleStMention(content, jid, quoted);
               case 'ORDER':
                   return await knz.handleOrderMessage(content, jid, quoted);
               case 'CAROUSEL':
                   return await knz.handleCarousel(content, jid, quoted);
               case 'GROUP_STORY':
                   return await knz.handleGroupStory(content, jid, quoted);
           }
       }

       const fullMsg = await Utils_1.generateWAMessage(jid, content, {
           logger,
           userJid,
           quoted,
           getUrlInfo: text => link_preview_1.getUrlInfo(text, {
               thumbnailWidth: linkPreviewImageThumbnailWidth,
               fetchOpts: {
                   timeout: 3000,
                   ...axiosOptions || {}
               },
               logger,
               uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
           }),
           upload: async (readStream, opts) => {
               const up = await waUploadToServer(readStream, {
                   ...opts,
                   newsletter: WABinary_1.isJidNewsletter(jid)
               });
               return up;
           },
           mediaCache: config.mediaCache,
           options: config.options,
           ...options
       });
       
       const isDeleteMsg = 'delete' in content && !!content.delete;
       const isEditMsg = 'edit' in content && !!content.edit;
       const isPinMsg = 'pin' in content && !!content.pin;
       const isPollMessage = 'poll' in content && !!content.poll;
       const isEventMsg = 'event' in content && !!content.event;
       const isAiMsg = ('ai' in content && !!content.ai) || messageType === 'AI_RICH_MSG';
       
       const additionalAttributes = {};
       const additionalNodes = [];

       if (options.additionalNodes && Array.isArray(options.additionalNodes)) {
           additionalNodes.push(...options.additionalNodes);
       }

       if (isDeleteMsg) {
           const fromMe = content.delete?.fromMe;
           const isGroup = WABinary_1.isJidGroup(content.delete?.remoteJid);
           additionalAttributes.edit = (isGroup && !fromMe) || WABinary_1.isJidNewsletter(jid) ? '8' : '7';
       } else if (isEditMsg) {
           additionalAttributes.edit = WABinary_1.isJidNewsletter(jid) ? '3' : '1';
       } else if (isPinMsg) {
           additionalAttributes.edit = '2';
       }

       if (isAiMsg) {
           additionalNodes.push({
               attrs: { 
                   biz_bot: '1' 
               }, tag: "bot" 
           });
       } else if (isPollMessage) {
           additionalNodes.push({
               tag: 'meta',
               attrs: {
                   polltype: 'creation'
               }
           });
       } else if (isEventMsg) {
           additionalNodes.push({
               tag: 'meta',
               attrs: {
                   event_type: 'creation'
               }
           });
       }
       
       await relayMessage(jid, fullMsg.message, {
           messageId: fullMsg.key.id,
           cachedGroupMetadata: options.cachedGroupMetadata,
           additionalNodes,
           additionalAttributes,
           statusJidList: options.statusJidList
       });
       
       if (config.emitOwnEvents) {
           process.nextTick(() => {
               processingMutex.mutex(() => upsertMessage(fullMsg, 'append'));
           });
       }
       return fullMsg;
      }
    }
  }
};

module.exports = {
    makeMessagesSocket
}
