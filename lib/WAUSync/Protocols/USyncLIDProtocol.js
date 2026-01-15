"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const WABinary_1 = require("../../WABinary")

class USyncLIDProtocol {
	constructor() {
		this.name = 'lid'
	}
	getQueryElement() {
		return {
			tag: 'lid', 
			attrs: {}
		}
	}
	getUserElement(user) {
        if (user.lid) {
            return {
                tag: 'lid',
                attrs: { jid: user.lid }
            }
        }
        else {
            return null
        }
    }
	parser(node) {
		if (node.tag === 'lid') {
			return node.attrs.val
		}		
		return null
	}
}

module.exports = {
 USyncLIDProtocol
}

/********************************⧼  Development Baileys   ⧽********************************/

// [👤] Name: Kenz • Coding
// [📞] Chenal: https://whatsapp.com/channel/0029VayL3sYB4hdXBnKa7E37
// [📁] Instagram: https://www.instagram.com/kenz.offc?igsh=MWk3eXVsaHN1OXU0cQ==