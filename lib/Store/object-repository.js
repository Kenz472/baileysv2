"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

class ObjectRepository {
    constructor(entities = {}) {
        this.entityMap = new Map(Object.entries(entities))
    }
    findById(id) {
        return this.entityMap.get(id)
    }
    findAll() {
        return Array.from(this.entityMap.values())
    }
    upsertById(id, entity) {
        return this.entityMap.set(id, { ...entity })
    }
    deleteById(id) {
        return this.entityMap.delete(id)
    }
    count() {
        return this.entityMap.size
    }
    toJSON() {
        return this.findAll()
    }
}

module.exports = {
  ObjectRepository
}

/********************************⧼  Development Baileys   ⧽********************************/

// [👤] Name: Kenz • Coding
// [📞] Chenal: https://whatsapp.com/channel/0029VayL3sYB4hdXBnKa7E37
// [📁] Instagram: https://www.instagram.com/kenz.offc?igsh=MWk3eXVsaHN1OXU0cQ==