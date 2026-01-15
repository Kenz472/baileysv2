# 🚀 Baileys @waguri/baileys

<div align="center">
    
![WhatsApp API Banner](https://raw.githubusercontent.com/Kenz472/Shiina_Tourl/main/uploads/IMG-20260112-WA0037.jpg)

*A powerful WebSockets-based TypeScript library for interacting with the WhatsApp Web API**

[![☏ Chennall](https://img.shields.io/badge/WhatsApp-Join-green?logo=whatsapp)](https://chat.whatsapp.com/HlyYOczlYcn9JipRVchJxE) 

[![Subscribe YouTube](https://img.shields.io/badge/Subscribe-YouTube-red?logo=youtube)](https://www.youtube.com/@Ken_botz_pemula)

[![Join Telegram](https://img.shields.io/badge/Join-Telegram-blue?logo=telegram)](https://t.me/@Kenz_472)

[![Follow Instagram](https://img.shields.io/badge/Follow-Instagram-critical?logo=instagram)](https://www.instagram.com/kenz.offc?igsh=MWk3eXVsaHN1OXU0cQ==)

</div>

### 📦 Installation

<div align="center">

```bash
# 📦 how to run it
"@adiwajshing/baileys": "github:Kenz472/Baileys"
"@whiskeysockets/baileys": "github:Kenz472/Baileys"
"@waguri/baileys": "github:Kenz472/Baileys"
```

</div>

### 🔌 Basic Usage

```javascript
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require("@waguri/baileys);
const { Boom } = require('@hapi/boom');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting...', shouldReconnect);
            
            if(shouldReconnect) {
                connectToWhatsApp();
            }
        } else if(connection === 'open') {
            console.log('✅ Connected to WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        console.log('📩 New message:', JSON.stringify(m, undefined, 2));
        
        // Echo received messages
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            await sock.sendMessage(msg.key.remoteJid, { text: 'Hello! 👋' });
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();
```

---



## 🔌 Connecting Account

### 📱 Starting socket with **QR-CODE**

<div align="center">

> [!TIP]
> **Pro Tip:** Customize browser name using the `Browser` constant. See [available browsers](https://baileys.whiskeysockets.io/types/BrowsersMap.html).

</div>

```javascript
const { default: makeWASocket, Browsers } = require("@waguri/baileys);

const sock = makeWASocket({
    browser: Browsers.ubuntu('My App'),
    printQRInTerminal: true
});
```

### 🔢 Starting socket with **Pairing Code**

<div align="center">

> [!IMPORTANT]
> **Pairing Code connects WhatsApp Web without QR-CODE.**  
> Phone number format: country code + number (no +, (), or -)

</div>

```javascript
const sock = makeWASocket({
    printQRInTerminal: false // Must be false for pairing code
});

// Standard pairing
if (!sock.authState.creds.registered) {
    const number = '628*******'; // Your phone number
    const code = await sock.requestPairingCode(number);
    console.log('🔑 Pairing Code:', code);
}

// Custom pairing (8 digits/letters)
if (!sock.authState.creds.registered) {
    const customPair = "12345678";
    const number = '628*******';
    const code = await sock.requestPairingCode(number, customPair);
    console.log('🔑 Custom Pairing Code:', code);
}
```

---

## 💾 Saving & Restoring Sessions

<div align="center">

**🎯 Never scan QR codes again! Save your session:**

</div>

</td>
</tr>
</table>

</div>

### 📝 Text Message
```javascript
await sock.sendMessage(jid, { text: 'Hello World! 🌍' });
```

### 𖠋 Button Message
```javascript
await sock.sendMessage(jid, {
    text:"simple Baileys",
    footer: "Baileys: @waguri/baileys",
    buttons: [
        {
            buttonId: 'btn1',
            buttonText: { displayText: '✅ Option 1' },
            type: 1
        },
        {
            buttonId: 'btn2',
            buttonText: { displayText: '❌ Option 2' },
            type: 1
        }
    ],
    headerType: 1
});
```

### 🎯 Interactive Message with Flow
```javascript
await sock.sendMessage(jid, {
    text:"simple Baileys",
    footer: "Baileys: @waguri/baileys",
    buttons: [
        {
            buttonId: 'menu',
            buttonText: { displayText: '📋 Show Menu' },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'Select Option',
                    sections: [{
                        title: 'Available Options',
                        highlight_label: '⭐',
                        rows: [
                            {
                                header: 'OPTION 1',
                                title: 'First Choice',
                                description: 'Description for option 1',
                                id: 'opt1'
                            },
                            {
                                header: 'OPTION 2', 
                                title: 'Second Choice',
                                description: 'Description for option 2',
                                id: 'opt2'
                            }
                        ]
                    }]
                })
            }
        }
    ]
});
```

### 📸 Album Message
```javascript
await sock.sendMessage(jid, { 
    albumMessage: [
        { image: cihuy, caption: "Foto pertama" },
        { image: { url: "URL IMAGE" }, caption: "Foto kedua" }
    ] 
}, { quoted: m });
```

### #️⃣ Status Mentions Message
```javascript
await sock.sendStatusMentions({
  image: {
    url: 'https://example.com/image.jpg'
  }, 
  caption: 'Nice day!'
}, ["123@s.whatsapp.net", "123@s.whatsapp.net"])
```

### 🎊 Status Sw Groups
```javaScript
sock.sendMessage(idgc, {
groupStatusMessage: {
image: buffer,// -- > image, video, audio, text
caption
},  { quoted: m })
```

### 🛍️ Product Message
```javascript
await sock.sendMessage(jid, {
  product: {
    productId: '123',
    title: 'Cool T-Shirt',
    description: '100% cotton',
    price: 1999, // In cents (e.g., $19.99)
    currencyCode: 'USD',
    productImage: fs.readFileSync('thumbail.jpg')
  }
});
```

### 👤 Contact Message
```javascript
let vcard = 'BEGIN:VCARD\n' +
'VERSION:3.0\n' +
'N:WhatsApp;👑 Saya Owner yoruka kirihime;Bot;;Md\n' +
'FN:' + nameown + '\n' +
'NICKNAME:👑 KenzoFFC\n' +
'ORG:Wudy\n' +
'TITLE:soft\n' +
'item1.TEL;waid=' + nomorown + ':' + nomorown + '\n' +
'item1.X-ABLabel:📞 Nomor Owner\n' +
'item2.URL:' + syt + '\n' +
'item2.X-ABLabel:💬 More\n' +
'item3.EMAIL;type=INTERNET:kenshop@gmail.com\n' +
'item3.X-ABLabel:💌 kenzshop@gmail.com\n' +
'item4.ADR:;; 🇮🇩 KOTA INDONESIA;;;;\n' +
'item4.X-ABADR:💬 More\n' +
'item4.X-ABLabel:lampung Selatan\n' +
'BDAY;value=date:🔖 13 juni 2001\n' +
'END:VCARD';

await sock.sendMessage(jid, { 
  contacts: { 
    displayName: 'Your Name', 
    contacts: [{ vcard }] 
  }
})
```

### 📆 Event Message
```javascript
await sock.sendMessage(jid, { 
    eventMessage: { 
        isCanceled: false, 
        name: "Hello World", 
        description: "join le ", 
        location: { 
            degreesLatitude: 0, 
            degreesLongitude: 0, 
            name: "rowrrrr" 
        }, 
        joinLink: "https://call.whatsapp.com/video/43xtEuktao7rnCyXKOX39l", 
        startTime: "1763019000", 
        endTime: "1763026200", 
        extraGuestsAllowed: false 
    } 
}, { quoted: m });
```



### 🍎 Simple Button Coppy
```javascript
await sock.sendMessage(jid, {
    interactiveMessage: {
        header: "Hello World",
        title:"simple Baileys",
        footer: "Baileys: @waguri/baileys",
        buttons: [
            {
                name: "cta_copy",
                buttonParamsJson: JSON.stringify({
                    display_text: "copy code",
                    id: "123456789",              
                    copy_code: "ABC123XYZ"
                })
            }
        ]
    }
}, { quoted: m });
```

    
### ✨ Interactive Message with Native Flow
```javascript
await sock.sendMessage(jid, {    
    interactiveMessage: {      
        header: "Hello World",
        title:"simple Baileys",
        footer: "Baileys: @waguri/baileys",
        image: { url: "https://example.com/image.jpg" },
        nativeFlowMessage: {        
            messageParamsJson: JSON.stringify({          
                limited_time_offer: {            
                    text: "idk hummmm?",            
                    url: "https:wa.me/62xxx",            
                    copy_code: "Baileys",            
                    expiration_time: Date.now() * 999          
                },          
                bottom_sheet: {            
                    in_thread_buttons_limit: 2,            
                    divider_indices: [1, 2, 3, 4, 5, 999],            
                    list_title: "Baileys WhatsApp",            
                    button_title: "Baileys WhatsApp"          
                },          
                tap_target_configuration: {            
                    title: " X ",            
                    description: "bomboclard",
                    canonical_url: "https://t.me/***",
                    domain: "shop.example.com",
                    button_index: 0          
                }        
            }),        
            buttons: [          
                {            
                    name: "single_select",            
                    buttonParamsJson: JSON.stringify({
                        has_multiple_buttons: true
                    })
                },
                {
                    name: "call_permission_request",
                    buttonParamsJson: JSON.stringify({
                        has_multiple_buttons: true
                    })
                },          
                {            
                    name: "single_select",            
                    buttonParamsJson: JSON.stringify({
                        title: "Hello World",              
                        sections: [
                                {
                                title: "title",
                                highlight_label: "label",
                                rows: [
                                    {
                                        title: "Mahiru",
                                        description: "love you",
                                        id: "row_2"
                                    }                  
                                ]                
                            }              
                        ],              
                        has_multiple_buttons: true            
                    })          
                },          
                {            
                    name: "cta_copy",            
                    buttonParamsJson: JSON.stringify({              
                        display_text: "copy code",              
                        id: "123456789",              
                        copy_code: "ABC123XYZ"            
                    })          
                }        
            ]      
        }    
    }  
}, { quoted: m });
```

### 🐢 Product Button Message
```javascript
await sock.sendMessage(jid, {
    productMessage: {
        title: "Produk Contoh",
        description: "Ini adalah deskripsi produk",
        thumbnail: { url: "https://example.com/image.jpg" },
        productId: "PROD001",
        retailerId: "RETAIL001",
        url: "https://example.com/product",
        body: "Detail produk",
        footer: "Harga spesial",
        priceAmount1000: 50000,
        currencyCode: "USD",
        buttons: [
            {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                    display_text: "Beli Sekarang",
                    url: "https://example.com/buy"
                })
            }
        ]
    }
}, { quoted: m });
```

### 📚 Interactive Message with Document Buffer
```javascript
await sock.sendMessage(jid, {
    interactiveMessage: {
        header: "Hello World",
        title: "Hello World",
        footer: "telegram: @Baileys WhatsApp",
        document: fs.readFileSync("./package.json"),
        mimetype: "application/pdf",
        fileName: "Baileys WhatsAppvtc.pdf",
        jpegThumbnail: fs.readFileSync("./document.jpeg"),
        contextInfo: {
            mentionedJid: [jid],
            forwardingScore: 777,
            isForwarded: false
        },
        externalAdReply: {
            title: "shenń Bot",
            body: "anu team",
            mediaType: 3,
            thumbnailUrl: "https://example.com/image.jpg",
            mediaUrl: " X ",
            sourceUrl: "https://t.me/**",
            showAdAttribution: true,
            renderLargerThumbnail: false         
        },
        buttons: [
            {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                    display_text: "Telegram",
                    url: "https://t.me/Baileys WhatsAppvtc",
                    merchant_url: "https://t.me/Baileys WhatsAppvtc"
                })
            }
        ]
    }
}, { quoted: m });
```

### 📋 Poll Message
```javascript
await sock.sendMessage(jid, {
    poll: {
        name: 'What\'s your favorite color? 🎨',
        values: ['🔴 Red', '🔵 Blue', '🟢 Green', '🟡 Yellow'],
        selectableCount: 1
    }
});
```
### 🥀 Button message Geser

```javascript
await sock.sendMessage(jid,
  {
    text: '📢 Isi Utama Pesan',
    title: '🗂️ Judul Utama',
    subtile: '📌 Subjudul Opsional',
    footer: '📩 Footer Pesan',
    cards: [
      {
        image: { url: 'https://www.example.com' },
        title: '🖼️ Judul Kartu',
        body: '📝 Isi Konten Kartu',
        footer: '📍 Footer Kartu',
        buttons: [
          {
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
              display_text: '💬 Tombol Cepat',
              id: 'ID_TOMBOL_1'
            })
          },
          {
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
              display_text: '🔗 Kunjungi Website',
              url: 'https://www.example.com'
            })
          }
        ]
      },
      {
        image: { url: pp }, // Bisa juga Buffer gambar
        title: '🎥 Judul Kartu Video',
        body: '📝 Deskripsi Konten',
        footer: '📍 Footer Kartu',
        buttons: [
          {
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
              display_text: '⚡ Respon Cepat',
              id: 'ID_TOMBOL_2'
            })
          },
          {
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
              display_text: '🔎 Lihat Selengkapnya',
              url: 'https://www.example.com'
            })
          }
        ]
      }
    ]
  }
)
```

<div align="center">

### 🎬 Media Messages

<table>
<tr>
<td align="center" width="33%">

**🖼️ Images**
JPG, PNG, WebP support

</td>
<td align="center" width="33%">

**🎥 Videos**
MP4, AVI with captions

</td>
<td align="center" width="33%">

**🎵 Audio**
Voice notes & music

</td>
</tr>
</table>

</div>

### 🖼️ Image Message
```javascript
await sock.sendMessage(jid, {
    image: { url: './path/to/image.jpg' },
    caption: 'Beautiful image! 📸'
});
```

### 🎥 Video Message
```javascript
await sock.sendMessage(jid, {
    video: { url: './path/to/video.mp4' },
    caption: 'Check this out! 🎬',
    ptv: false // Set to true for video note
});
```

### 🎵 Audio Message
```javascript
await sock.sendMessage(jid, {
    audio: { url: './path/to/audio.mp3' },
    mimetype: 'audio/mp4'
});
```

---

## 📊 Implementing a Data Store

<div align="center">

> [!IMPORTANT]
> **Production Ready:** Build your own data store for production. The in-memory store is just for testing!

</div>

```javascript
const { makeInMemoryStore } = require("@Kenz472/baileys/");

const store = makeInMemoryStore({});

// Load from file
store.readFromFile('./baileys_store.json');

// Auto-save every 10 seconds
setInterval(() => {
    store.writeToFile('./baileys_store.json');
}, 10_000);

// Bind to socket
const sock = makeWASocket({});
store.bind(sock.ev);

// Access stored data
sock.ev.on('chats.upsert', () => {
    console.log('💬 Chats:', store.chats.all());
});
```

---

## 👥 Groups

<div align="center">

### 🎯 Group Management Features

<table>
<tr>
<td align="center" width="25%">

**🆕 Create**  
New groups

</td>
<td align="center" width="25%">

**👤 Members**  
Add/Remove users

</td>
<td align="center" width="25%">

**⚙️ Settings**  
Name, description

</td>
<td align="center" width="25%">

**🛡️ Admin**  
Promote/Demote

</td>
</tr>
</table>

</div>

### 🆕 Create a Group
```javascript
const group = await sock.groupCreate('🎉 My Awesome Group', [
    '628*******@s.whatsapp.net',
    '0987654321@s.whatsapp.net'
]);

console.log('✅ Group created:', group.id);
await sock.sendMessage(group.id, { text: 'Welcome everyone! 👋' });
```

### 👤 Add/Remove Participants
```javascript
await sock.groupParticipantsUpdate(
    groupJid,
    ['628*******@s.whatsapp.net'],
    'add' // 'remove', 'promote', 'demote'
);
```

### ⚙️ Change Group Settings
```javascript
// Update group name
await sock.groupUpdateSubject(groupJid, '🚀 New Group Name');

// Update description
await sock.groupUpdateDescription(groupJid, '📝 New group description');

// Admin-only messages
await sock.groupSettingUpdate(groupJid, 'announcement');

// Everyone can send messages
await sock.groupSettingUpdate(groupJid, 'not_announcement');
```

---

## 🔒 Privacy

<div align="center">

### 🛡️ Privacy Controls

<table>
<tr>
<td align="center" width="50%">

**🚫 Block Management**  
Block/Unblock users

</td>
<td align="center" width="50%">

**⚙️ Privacy Settings**  
Visibility controls

</td>
</tr>
</table>

</div>

### 🚫 Block/Unblock Users
```javascript
// Block user
await sock.updateBlockStatus(jid, 'block');

// Unblock user  
await sock.updateBlockStatus(jid, 'unblock');
```

### ⚙️ Privacy Settings
```javascript
// Update various privacy settings
await sock.updateLastSeenPrivacy('contacts'); // 'all', 'contacts', 'none'
await sock.updateOnlinePrivacy('all'); // 'all', 'match_last_seen'
await sock.updateProfilePicturePrivacy('contacts');
await sock.updateStatusPrivacy('contacts');
await sock.updateReadReceiptsPrivacy('all'); // 'all', 'none'
```

---

## 🐛 Debugging

<div align="center">

**🔍 Enable debug mode to see all WhatsApp communications:**

</div>

```javascript
const sock = makeWASocket({
    logger: P({ level: 'debug' }),
});
```

### 🎯 Custom Event Handlers
```javascript
// Listen for specific WebSocket events
sock.ws.on('CB:edge_routing', (node) => {
    console.log('📡 Edge routing message:', node);
});

// Listen with specific attributes
sock.ws.on('CB:edge_routing,id:abcd', (node) => {
    console.log('🎯 Specific edge routing message:', node);
});
```

---

<div align="center">

<br>

✨ Terima kasih sudah menggunakan Baileys kami! ✨  
🙏 Terima kasih juga atas support kalian yang luar biasa! 🙏

</div>
