// bot.js — Unobuono Bot v3.1 — Fix Gemini Quota & Stability
require('dotenv').config()
const TelegramBot = require('node-telegram-bot-api')
const cron = require('node-cron')
const https = require('https')
const db = require('./db')

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true })

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => { console.error('Unhandled:', reason) })
process.on('uncaughtException', (err) => { console.error('Uncaught:', err) })

// ─── UTILITIES ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function typing(chatId, ms = 1200) {
  try { await bot.sendChatAction(chatId, 'typing'); await sleep(ms) } catch(e) {}
}

async function send(chatId, text, options = {}) {
  try { return await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...options }) }
  catch(e) { console.error('Send error:', e.message) }
}

async function downloadImage(fileId) {
  const fileLink = await bot.getFileLink(fileId)
  return new Promise((resolve, reject) => {
    https.get(fileLink, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
  })
}

// ─── AI FUNCTIONS (FIXED MODEL & QUOTA) ───────────────────────────────────────

async function readInvoice(imageBase64) {
  try {
    // Usiamo gemini-1.5-flash per maggiore stabilità e quota gratuita più alta
    const url = `[https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=$){process.env.GEMINI_API_KEY}`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
              { text: `Sei un assistente per ristoranti italiani. Analizza questa fattura/bolla e estrai i dati. Rispondi SOLO con un oggetto JSON valido: {"fornitore": {"nome": "...", "telefono": "...", "email": "..."}, "prodotti": [{"nome": "...", "quantita": 0, "unita": "kg", "prezzo_unitario": 0, "categoria": "altro"}], "totale": 0, "data": "YYYY-MM-DD"}` }
            ]
          }],
          generationConfig: { temperature: 0.1 }
        })
      }
    )

    const data = await response.json()
    
    // Gestione errore quota o API
    if (data.error) {
      console.error('Gemini API Error:', data.error.message)
      return null
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    
    if (!text) {
      console.error('Gemini returned empty text')
      return null
    }

    // Pulizia del testo da Markdown e parsing sicuro
    const cleanJson = text.replace(/```json|```/g, '').trim()
    return JSON.parse(cleanJson)

  } catch(e) {
    console.error('readInvoice system error:', e.message)
    return null
  }
}

async function chatResponse(text, restaurantName) {
  try {
    const url = `[https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=$){process.env.GEMINI_API_KEY}`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: `Sei l'assistente rifornimenti di ${restaurantName || 'questo ristorante'}. Sei pratico, caldo, diretto. Rispondi in italiano informale. Messaggio: "${text}". Rispondi in max 3 righe.` }]
          }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 300 }
        })
      }
    )
    const data = await response.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Scusa, ho avuto un piccolo problema. Puoi ripetere?'
  } catch(e) {
    console.error('chatResponse error:', e.message)
    return 'Errore di connessione. Riprova tra un momento.'
  }
}

// ─── STEP 1: BENVENUTO ────────────────────────────────────────────────────────
async function stepWelcome(chatId) {
  await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_name' })
  await typing(chatId, 800)
  await send(chatId, `👋 <b>Ciao! Sono il tuo assistente Unobuono.</b>

Monitoro le scorte del tuo ristorante e ogni sera ti dico cosa ordinare — tutto qui su Telegram.

Prima cosa: <b>come si chiama il tuo ristorante?</b>`)
}

// ─── STEP 2: TIPO LOCALE ──────────────────────────────────────────────────────
async function stepType(chatId, name) {
  await db.upsertRestaurant(chatId, { name, onboarding_step: 'awaiting_type' })
  await typing(chatId, 600)
  await send(chatId, `Perfetto, <b>${name}</b>! 🍽\n\nChe tipo di locale è?`, {
    reply_markup: {
      keyboard: [['🍕 Pizzeria', '🍝 Ristorante'], ['🍷 Bistrot / Osteria', '🥐 Bakery / Caffè'], ['Altro']],
      resize_keyboard: true, one_time_keyboard: true
    }
  })
}

// ─── STEP 3: CITTÀ ────────────────────────────────────────────────────────────
async function stepCity(chatId, type) {
  await db.upsertRestaurant(chatId, { type, onboarding_step: 'awaiting_city' })
  await typing(chatId, 600)
  await send(chatId, `In quale città siete?`, { reply_markup: { remove_keyboard: true } })
}

// ─── STEP 4: FATTURE ─────────────────────────────────────────────────────────
async function stepInvoices(chatId, city) {
  await db.upsertRestaurant(chatId, { city, onboarding_step: 'awaiting_invoices', invoices_received: 0 })
  await typing(chatId, 1000)
  await send(chatId, `📄 <b>Ora la parte più importante.</b>

Fotografa le tue <b>ultime 3-5 fatture</b> dei fornitori — quelle che usi di più.

Mandamele una per una. Quando hai finito, scrivi <b>FINE</b>.`)
}

// ─── GESTIONE FOTO FATTURA ────────────────────────────────────────────────────
async function handleInvoicePhoto(chatId, photo) {
  try {
    const rest = await db.getRestaurant(chatId)
    await send(chatId, '🔍 Sto leggendo la fattura...')
    
    const fileId = photo[photo.length - 1].file_id
    const buffer = await downloadImage(fileId)
    const base64 = buffer.toString('base64')
    const invoice = await readInvoice(base64)

    if (!invoice || !invoice.prodotti) {
      await send(chatId, '⚠️ Non sono riuscito a leggere questa fattura (possibile limite API raggiunto). Prova tra poco o mandane un\'altra.')
      return
    }

    // Salvataggio Fornitore
    if (invoice.fornitore?.nome) {
      const productNames = invoice.prodotti.map(p => p.nome).slice(0, 5).join(', ')
      await db.addSupplier(rest.id, {
        name: invoice.fornitore.nome,
        phone: invoice.fornitore.telefono || null,
        ingredient_name: productNames,
        type: 'food'
      }).catch(() => {})
    }

    // Salvataggio Ingredienti
    const ingredients = invoice.prodotti.map((p, i) => ({
      name: p.nome,
      weeklyOrder: p.quantita || 1,
      unit: p.unita || 'kg',
      sort_order: i
    }))

    for (const ing of ingredients) {
      const existing = await db.getIngredients(rest.id)
      if (!existing.find(e => e.name.toLowerCase() === ing.name.toLowerCase())) {
        await db.bulkAddIngredients(rest.id, [ing]).catch(() => {})
      }
    }

    const count = (rest.invoices_received || 0) + 1
    await db.upsertRestaurant(chatId, { invoices_received: count })

    let txt = `✅ <b>Fattura ${count} letta!</b>\n\n`
    if (invoice.fornitore?.nome) txt += `🏢 <b>Fornitore:</b> ${invoice.fornitore.nome}\n`
    txt += `\n<b>Prodotti principali:</b>\n`
    invoice.prodotti.slice(0, 5).forEach(p => {
      txt += `• ${p.nome}: ${p.quantita}${p.unita}\n`
    })
    txt += `\n<i>Manda la prossima o scrivi FINE.</i>`

    await send(chatId, txt)
  } catch(e) {
    console.error('handleInvoicePhoto error:', e)
    await send(chatId, '❌ Errore tecnico nel caricamento. Riprova.')
  }
}

// ─── STEP 5: RIEPILOGO E STOCK INIZIALE ──────────────────────────────────────
async function stepSummary(chatId) {
  try {
    const rest = await db.getRestaurant(chatId)
    const ingredients = await db.getIngredients(rest.id)

    if (ingredients.length === 0) {
      await send(chatId, '⚠️ Non ho trovato ingredienti. Dimmi i tuoi principali (uno per riga):\n\n<i>Farina — 50kg\nMozzarella — 8kg</i>')
      await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_manual_ingredients' })
      return
    }

    await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_stock' })
    await typing(chatId, 1000)

    let txt = `📊 <b>Ho trovato ${ingredients.length} prodotti.</b>\n\n`
    txt += `<b>Ultima cosa</b> — quanto hai in stock <b>adesso</b>? Rispondi con i numeri:\n\n`

    ingredients.slice(0, 8).forEach((ing, i) => {
      txt += `${i + 1}. ${ing.name} (ordine tipico: ${ing.weekly_order}${ing.unit})\n`
    })
    txt += `\n<i>Es: "1. quasi finito, 2. ok"</i>`

    await send(chatId, txt)
  } catch(e) {
    await send(chatId, '❌ Errore. Scrivi /start.')
  }
}

// [MANTENERE GLI ALTRI HANDLER: handleInitialStock, confirmOrders, generateStockAlert, ecc. che sono già nel tuo codice originale]
// ... (omessi per brevità, ma rimangono identici)

// ─── COMMANDS ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  try { await stepWelcome(msg.chat.id) }
  catch(e) { console.error('/start error:', e) }
})

bot.onText(/\/reset/, async (msg) => {
  await db.upsertRestaurant(msg.chat.id, { onboarding_step: 'welcome', onboarding_complete: false, invoices_received: 0 })
  await send(msg.chat.id, '🔄 Reset effettuato. Scrivi /start.')
})

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id
  const rest = await db.getRestaurant(chatId)
  if (!rest) return
  
  if (rest.onboarding_step === 'awaiting_invoices') {
    await handleInvoicePhoto(chatId, msg.photo)
  }
})

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return
  const chatId = msg.chat.id
  const text = msg.text.trim()
  const rest = await db.getRestaurant(chatId)
  if (!rest) return

  const step = rest.onboarding_step || 'welcome'

  switch(step) {
    case 'awaiting_name': await stepType(chatId, text); break;
    case 'awaiting_type': await stepCity(chatId, text); break;
    case 'awaiting_city': await stepInvoices(chatId, text); break;
    case 'awaiting_invoices': 
      if (text.toUpperCase() === 'FINE') await stepSummary(chatId); 
      break;
    case 'active':
      const response = await chatResponse(text, rest.name);
      await send(chatId, response);
      break;
  }
})

console.log('🚀 Unobuono Bot v3.1 (Gemini 1.5 Stable) — Online!')
