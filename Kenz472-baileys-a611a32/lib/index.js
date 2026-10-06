"use strict";

const chalk = require("chalk");

console.log(`
  ${chalk.cyan('────『 I N F O C A T I O N 』────')}
  ${chalk.yellow('Baileys:')} ${chalk.green('@waguri/baileys')}
  ${chalk.yellow('Update:')} ${chalk.green('12 - Jun - 2026')}
  ${chalk.yellow('Author:')} ${chalk.green('{ K E N Z • C O D I N G }')}
  ${chalk.red('↓Pesan:↓')}
  ${chalk.blue('Terimakasih sudah menggunakan Bailey kami.')}
  ${chalk.blue('Jika ada kendala error, bisa chat development yah...')}
`);

var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
  if (k2 === undefined) k2 = k;
  var desc = Object.getOwnPropertyDescriptor(m, k);
  if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
    desc = { enumerable: true, get: function() { return m[k]; } };
  }
  Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
  if (k2 === undefined) k2 = k;
  o[k2] = m[k];
}));

var __exportStar = (this && this.__exportStar) || function(m, exports) {
  for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};

var __importDefault = (this && this.__importDefault) || function (mod) {
  return (mod && mod.__esModule) ? mod : { "default": mod };
};

Object.defineProperty(exports, "__esModule", { value: true });

exports.makeWASocket = void 0;

const Socket_1 = __importDefault(require("./Socket"));

exports.makeWASocket = Socket_1.default;

__exportStar(require("../WAProto"), exports);
__exportStar(require("./Utils"), exports);
__exportStar(require("./Types"), exports);
__exportStar(require("./Store"), exports);
__exportStar(require("./Defaults"), exports);
__exportStar(require("./WABinary"), exports);
__exportStar(require("./WAM"), exports);
__exportStar(require("./WAUSync"), exports);

exports.default = Socket_1.default;

/********************************⧼  Development Baileys   ⧽********************************/

// [👤] Name: Kenz • Coding
// [📞] Chenal: https://whatsapp.com/channel/0029VayL3sYB4hdXBnKa7E37
// [📁] Instagram: https://www.instagram.com/kenz.offc?igsh=MWk3eXVsaHN1OXU0cQ==