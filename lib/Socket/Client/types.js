"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const events_1 = require("events")

class AbstractSocketClient extends events_1.EventEmitter {
    constructor(url, config) {
        super()
        this.url = url
        this.config = config
        this.setMaxListeners(0)
    }
}

module.exports = {
  AbstractSocketClient
}

/********************************⧼  Development Baileys   ⧽********************************/

// [👤] Name: Kenz • Coding
// [📞] Chenal: https://whatsapp.com/channel/0029VayL3sYB4hdXBnKa7E37
// [📁] Instagram: https://www.instagram.com/kenz.offc?igsh=MWk3eXVsaHN1OXU0cQ==