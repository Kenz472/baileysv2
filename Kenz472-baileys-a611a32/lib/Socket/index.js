"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const Defaults_1 = require("../Defaults")
const community_1 = require("./community")

// export the last socket layer
const makeWASocket = (config) => {
	const newConfig = {
    	...Defaults_1.DEFAULT_CONNECTION_CONFIG,
   	 ...config
    }
    
    // If the user hasn't provided their own history sync function,
    // let's create a default one that respects the syncFullHistory flag.
    if (config.shouldSyncHistoryMessage === undefined) {
        newConfig.shouldSyncHistoryMessage = () => !!newConfig.syncFullHistory
    }

    return community_1.makeCommunitiesSocket(newConfig)
}

exports.default = makeWASocket


/********************************⧼  Development Baileys   ⧽********************************/

// [👤] Name: Kenz • Coding
// [📞] Chenal: https://whatsapp.com/channel/0029VayL3sYB4hdXBnKa7E37
// [📁] Instagram: https://www.instagram.com/kenz.offc?igsh=MWk3eXVsaHN1OXU0cQ==