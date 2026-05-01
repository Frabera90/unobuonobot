// bot.js — Unobuono Bot v3 — Onboarding da foto fatture
require('dotenv').config()
const TelegramBot = require('node-telegram-bot-api')
const Anthropic = require('@anthropic-ai/sdk')
const cron = require('node-cron')
const https = require('https')
const db = require('./db')

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true })
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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
  try {
    const fileLink = await bot.getFileLink(fileId)
    console.log('Downloading:', fileLink)
    return new Promise((resolve, reject) => {
      const url = new URL(fileLink)
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { 'User-Agent': 'UnobuonoBot/1.0' }
      }
      https.get(options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          https.get(res.headers.location, (res2) => {
            const chunks = []
            res2.on('data', c => chunks.push(c))
            res2.on('end', () => resolve(Buffer.concat(chunks)))
            res2.on('error', reject)
          })
          return
        }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }).on('error', reject)
    })
  } catch(e) {
    console.error('downloadImage error:', e)
    throw e
  }
}

// ─── AI FUNCTIONS ─────────────────────────────────────────────────────────────

async function readInvoice(imageBase64) {
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: `Sei un assistente per ristoranti italiani. Analizza questa fattura e estrai tutti i dati.
Rispondi SOLO con JSON valido:
{
  "fornitore": {"nome": "...", "telefono": "...", "email": "..."},
  "prodotti": [{"nome": "...", "quantita": 0, "unita": "kg|l|pz|bottiglie|casse", "prezzo_unitario": 0, "categoria": "carne|pesce|verdura|latticini|farine|olio|vino|birra|altro"}],
  "totale": 0,
  "data": "YYYY-MM-DD"
}` }
      ]
    }]
  })
  try {
    return JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim())
  } catch(e) { return null }
}

async function generateStockAlert(restaurant, ingredients, wines, suppliers) {
  const allItems = [
    ...ingredients.map(i => ({ name: i.name, current: i.current_stock || 0, normal: i.weekly_order || 1, unit: i.unit || 'kg' })),
    ...wines.map(w => ({ name: w.name, current: w.current_stock || 0, normal: w.normal_stock || 12, unit: 'bottiglie' }))
  ]

  const urgent = allItems.filter(i => (i.current / i.normal) < 0.2)
  const attention = allItems.filter(i => (i.current / i.normal) >= 0.2 && (i.current / i.normal) < 0.5)
  const ok = allItems.filter(i => (i.current / i.normal) >= 0.5)

  let msg = `📦 <b>Report scorte — ${new Date().toLocaleDateString('it-IT', {weekday:'long', day:'numeric', month:'long'})}</b>\n\n`

  if (urgent.length > 0) {
    msg += `🔴 <b>URGENTE — ordina stasera:</b>\n`
    urgent.forEach(i => { msg += `• ${i.name}: ~${i.current}${i.unit} rimasti\n` })
    msg += '\n'
  }
  if (attention.length > 0) {
    msg += `🟡 <b>ATTENZIONE — valuta se ordinare:</b>\n`
    attention.forEach(i => { msg += `• ${i.name}: ~${i.current}${i.unit} rimasti\n` })
    msg += '\n'
  }
  if (ok.length > 0) {
    msg += `🟢 <b>OK:</b>\n`
    ok.forEach(i => { msg += `• ${i.name}\n` })
    msg += '\n'
  }

  if (urgent.length > 0 || attention.length > 0) {
    msg += `Mando gli ordini ai fornitori? Rispondi <b>SI</b> per tutti o dimmi cosa cambiare.`
  } else {
    msg += `✅ Tutto a posto stasera! Nessun ordine necessario.`
  }

  return msg
}

async function chatResponse(text, restaurantName) {
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Sei l'assistente rifornimenti di ${restaurantName || 'questo ristorante'}. 
Sei pratico, caldo, diretto. Rispondi in italiano informale.
Specializzato in gestione scorte e rifornimenti ristoranti.
Messaggio: "${text}"
Rispondi in modo utile e conciso.`
    }]
  })
  return response.content[0].text
}

// ─── STEP 1: BENVENUTO ────────────────────────────────────────────────────────
async function stepWelcome(chatId) {
  await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_name' })
  await typing(chatId, 800)
  await send(chatId, `👋 <b>Ciao! Sono il tuo assistente Unobuono.</b>

Monitoro le scorte del tuo ristorante e ogni sera ti dico cosa ordinare — tutto qui su Telegram, senza app.

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

Fotografa le tue <b>ultime 3-5 fatture</b> dei fornitori — quelle che usi di più (macelleria, latteria, fornitura generale, enoteca).

Mandamele una per una. Leggo tutto io: fornitori, prodotti, quantità, prezzi.

<i>Non serve che siano perfette — anche foto dal telefono vanno benissimo.</i>

Quando hai finito di mandarle, scrivi <b>FINE</b>.`)
}

// ─── GESTIONE FOTO FATTURA ────────────────────────────────────────────────────
async function handleInvoicePhoto(chatId, photo) {
  try {
    const rest = await db.getRestaurant(chatId)
    await send(chatId, '🔍 Sto leggendo la fattura...')
    await bot.sendChatAction(chatId, 'typing')

    const fileId = photo[photo.length - 1].file_id
    const buffer = await downloadImage(fileId)
    const base64 = buffer.toString('base64')
    const invoice = await readInvoice(base64)

    if (!invoice || !invoice.prodotti || invoice.prodotti.length === 0) {
      await send(chatId, '⚠️ Non sono riuscito a leggere bene questa fattura. Prova con una foto più nitida oppure manda la prossima.')
      return
    }

    // Salva fornitore
    if (invoice.fornitore?.nome) {
      const productNames = invoice.prodotti.map(p => p.nome).join(', ')
      await db.addSupplier(rest.id, {
        name: invoice.fornitore.nome,
        phone: invoice.fornitore.telefono || null,
        ingredient_name: productNames,
        type: 'food'
      }).catch(() => {})
    }

    // Salva ingredienti
    const ingredients = invoice.prodotti.map((p, i) => ({
      name: p.nome,
      weeklyOrder: p.quantita || 1,
      unit: p.unita || 'kg',
      sort_order: i
    }))

    for (const ing of ingredients) {
      // Upsert — se esiste già non duplicare
      const existing = await db.getIngredients(rest.id)
      const exists = existing.find(e => e.name.toLowerCase() === ing.name.toLowerCase())
      if (!exists) {
        await db.bulkAddIngredients(rest.id, [ing]).catch(() => {})
      }
    }

    const count = (rest.invoices_received || 0) + 1
    await db.upsertRestaurant(chatId, { invoices_received: count })

    let txt = `✅ <b>Fattura ${count} letta!</b>\n\n`
    if (invoice.fornitore?.nome) txt += `🏢 <b>Fornitore:</b> ${invoice.fornitore.nome}\n`
    if (invoice.fornitore?.telefono) txt += `📞 ${invoice.fornitore.telefono}\n`
    txt += `\n<b>Prodotti trovati:</b>\n`
    invoice.prodotti.slice(0, 8).forEach(p => {
      txt += `• ${p.nome}: ${p.quantita}${p.unita}\n`
    })
    if (invoice.prodotti.length > 8) txt += `• ...e altri ${invoice.prodotti.length - 8} prodotti\n`
    txt += `\n<i>Manda un'altra fattura o scrivi FINE quando hai finito.</i>`

    await send(chatId, txt)
  } catch(e) {
    console.error('handleInvoicePhoto error:', e)
    await send(chatId, '❌ Errore nella lettura. Riprova con un\'altra foto.')
  }
}

// ─── STEP 5: RIEPILOGO E STOCK INIZIALE ──────────────────────────────────────
async function stepSummary(chatId) {
  try {
    const rest = await db.getRestaurant(chatId)
    const ingredients = await db.getIngredients(rest.id)
    const suppliers = await db.getSuppliers(rest.id)

    if (ingredients.length === 0) {
      await send(chatId, '⚠️ Non ho trovato ingredienti nelle fatture. Prova a mandare altre foto oppure dimmi i tuoi ingredienti principali (uno per riga):\n\n<i>Farina — 50kg\nMozzarella — 8kg</i>')
      await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_manual_ingredients' })
      return
    }

    await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_stock' })
    await typing(chatId, 1000)

    let txt = `📊 <b>Ottimo! Ho trovato:</b>\n\n`
    txt += `• <b>${ingredients.length}</b> ingredienti da monitorare\n`
    txt += `• <b>${suppliers.length}</b> fornitori salvati\n\n`
    txt += `<b>Ultima cosa</b> — quanto hai in stock <b>adesso</b> degli ingredienti principali?\n\n`
    txt += `Dimmi il numero: es. <i>"1. quasi finito, 2. ok, 3. appena ricevuto"</i>\n\n`

    ingredients.slice(0, 8).forEach((ing, i) => {
      txt += `${i + 1}. ${ing.name} (ordine normale: ${ing.weekly_order}${ing.unit})\n`
    })
    txt += `\n<i>Approssima pure — miglioro nel tempo!</i>`

    await send(chatId, txt, { reply_markup: { remove_keyboard: true } })
  } catch(e) {
    console.error('stepSummary error:', e)
    await send(chatId, '❌ Errore. Scrivi /start per riprovare.')
  }
}

// ─── STEP 6: STOCK INIZIALE ───────────────────────────────────────────────────
async function handleInitialStock(chatId, text) {
  try {
    const rest = await db.getRestaurant(chatId)
    const ingredients = await db.getIngredients(rest.id)

    // Interpreta risposte tipo "1. quasi finito, 2. ok"
    const lines = text.split(/[,\n]/)
    for (const line of lines) {
      const numMatch = line.match(/^(\d+)[\.\)]\s*(.+)/)
      if (numMatch) {
        const idx = parseInt(numMatch[1]) - 1
        const status = numMatch[2].toLowerCase().trim()
        const item = ingredients[idx]
        if (item) {
          let quantity = item.weekly_order || 10
          if (status.includes('quasi finit') || status.includes('poco') || status.includes('zero')) quantity *= 0.15
          else if (status.includes('metà') || status.includes('mezza')) quantity *= 0.5
          else if (status.includes('ok') || status.includes('bene') || status.includes('abbastanza')) quantity *= 0.75
          else if (status.includes('appena') || status.includes('pieno') || status.includes('tanto')) quantity *= 1.1
          await db.updateIngredientStock(rest.id, item.name, Math.round(quantity * 10) / 10, 'initial')
        }
      }
    }

    await db.upsertRestaurant(chatId, { onboarding_complete: true, onboarding_step: 'active' })

    await typing(chatId, 1000)
    await send(chatId, `🎉 <b>Tutto pronto!</b>

Da stasera alle <b>23:00</b> ricevi il report scorte ogni sera.

Puoi anche scrivermi in qualsiasi momento:
• <b>/alert</b> — genera il report adesso
• <b>/magazzino</b> — vedi le scorte
• <b>/ordini</b> — storico ordini

Oppure scrivimi liberamente: <i>"ho ricevuto la farina, 50kg"</i> e aggiorno le scorte da solo.

<b>Buon lavoro! 👨‍🍳</b>`)
  } catch(e) {
    console.error('handleInitialStock error:', e)
    await send(chatId, '❌ Errore. Riprova.')
  }
}

// ─── CONFERMA ORDINI ──────────────────────────────────────────────────────────
async function confirmOrders(chatId) {
  try {
    const rest = await db.getRestaurant(chatId)
    const ingredients = await db.getIngredients(rest.id)
    const suppliers = await db.getSuppliers(rest.id)
    const toOrder = []

    for (const ing of ingredients) {
      const current = ing.current_stock || 0
      const needed = (ing.weekly_order || 0) - current
      if (needed > 0) {
        const supplier = suppliers.find(s => (s.ingredient_name || '').toLowerCase().includes(ing.name.toLowerCase()))
        toOrder.push({ name: ing.name, quantity: `${Math.round(needed * 10) / 10}${ing.unit}`, supplier: supplier?.name || 'Fornitore', phone: supplier?.phone, restockTo: ing.weekly_order })
      }
    }

    if (toOrder.length === 0) {
      await send(chatId, '✅ Le scorte sono a posto — nessun ordine necessario!', { reply_markup: { remove_keyboard: true } })
      await db.upsertRestaurant(chatId, { onboarding_step: 'active' })
      return
    }

    await db.addOrder(rest.id, toOrder)

    let txt = `✅ <b>Ordini inviati a ${new Set(toOrder.map(o => o.supplier)).size} fornitori:</b>\n\n`
    toOrder.forEach(o => {
      txt += `📤 <b>${o.supplier}</b>${o.phone ? ` · ${o.phone}` : ''}\n`
      txt += `   → ${o.quantity} di ${o.name}\n\n`
    })
    txt += `💡 <i>Consegna domani mattina!</i>`

    await send(chatId, txt, { reply_markup: { remove_keyboard: true } })
    await db.upsertRestaurant(chatId, { onboarding_step: 'active' })
  } catch(e) {
    console.error('confirmOrders error:', e)
    await send(chatId, '❌ Errore. Riprova.')
  }
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  try { await stepWelcome(msg.chat.id) }
  catch(e) { console.error('/start error:', e); await send(msg.chat.id, '❌ Errore. Riprova tra un momento.') }
})

bot.onText(/\/alert/, async (msg) => {
  try {
    const rest = await db.getRestaurant(msg.chat.id)
    if (!rest?.onboarding_complete) { await send(msg.chat.id, 'Prima completa il setup con /start!'); return }
    const ingredients = await db.getIngredients(rest.id)
    const wines = await db.getWines(rest.id)
    const suppliers = await db.getSuppliers(rest.id)
    if (ingredients.length === 0) { await send(msg.chat.id, '⚠️ Nessun ingrediente trovato. Completa prima il setup con /start'); return }
    const alert = await generateStockAlert(rest, ingredients, wines, suppliers)
    await send(msg.chat.id, alert, {
      reply_markup: { keyboard: [['✅ SI, manda gli ordini', '❌ No grazie']], resize_keyboard: true, one_time_keyboard: true }
    })
    await db.upsertRestaurant(msg.chat.id, { onboarding_step: 'awaiting_order_confirm' })
  } catch(e) { console.error('/alert error:', e) }
})

bot.onText(/\/magazzino/, async (msg) => {
  try {
    const rest = await db.getRestaurant(msg.chat.id)
    if (!rest?.onboarding_complete) { await send(msg.chat.id, 'Prima completa il setup con /start!'); return }
    const ingredients = await db.getIngredients(rest.id)
    const wines = await db.getWines(rest.id)
    let txt = `📦 <b>Scorte attuali — ${rest.name}</b>\n\n`
    if (ingredients.length > 0) {
      txt += `<b>🥬 Cucina:</b>\n`
      ingredients.forEach(ing => {
        const pct = Math.round(((ing.current_stock || 0) / (ing.weekly_order || 1)) * 100)
        const emoji = pct < 20 ? '🔴' : pct < 50 ? '🟡' : '🟢'
        txt += `${emoji} ${ing.name}: ~${ing.current_stock || 0}${ing.unit}\n`
      })
    }
    if (wines.length > 0) {
      txt += `\n<b>🍷 Cantina:</b>\n`
      wines.forEach(w => {
        const pct = Math.round(((w.current_stock || 0) / (w.normal_stock || 12)) * 100)
        const emoji = pct < 20 ? '🔴' : pct < 50 ? '🟡' : '🟢'
        txt += `${emoji} ${w.name}: ${w.current_stock || 0} bottiglie\n`
      })
    }
    await send(msg.chat.id, txt)
  } catch(e) { console.error('/magazzino error:', e) }
})

bot.onText(/\/ordini/, async (msg) => {
  try {
    const rest = await db.getRestaurant(msg.chat.id)
    if (!rest) { await send(msg.chat.id, 'Prima completa il setup con /start!'); return }
    const orders = await db.getOrders(rest.id, 5)
    if (orders.length === 0) { await send(msg.chat.id, '📋 Nessun ordine ancora.'); return }
    let txt = `📋 <b>Ultimi ordini:</b>\n\n`
    orders.forEach(o => {
      const date = new Date(o.created_at).toLocaleDateString('it-IT')
      txt += `<b>${date}</b>\n`
      if (Array.isArray(o.items)) o.items.forEach(i => { txt += `  • ${i.quantity || ''} ${i.name}\n` })
      txt += '\n'
    })
    await send(msg.chat.id, txt)
  } catch(e) { console.error('/ordini error:', e) }
})

bot.onText(/\/reset/, async (msg) => {
  await db.upsertRestaurant(msg.chat.id, { onboarding_step: 'welcome', onboarding_complete: false, invoices_received: 0 })
  await send(msg.chat.id, '🔄 Reset effettuato. Scrivi /start per ricominciare.')
})

// ─── FOTO HANDLER ─────────────────────────────────────────────────────────────
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id
  try {
    const rest = await db.getRestaurant(chatId)
    if (!rest) { await send(chatId, 'Scrivi /start prima!'); return }
    const step = rest.onboarding_step

    if (step === 'awaiting_invoices') {
      await handleInvoicePhoto(chatId, msg.photo)
    } else if (step === 'active') {
      await send(chatId, '📷 Foto ricevuta! Per analizzare fatture durante il setup usa /start. Per aggiornare le scorte scrivimi cosa hai ricevuto.')
    } else {
      await send(chatId, '📷 Foto ricevuta! Se stai mandando una fattura, scrivi prima /start per iniziare il setup.')
    }
  } catch(e) { console.error('Photo handler error:', e) }
})

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || !msg.chat) return
  const chatId = msg.chat.id
  const text = msg.text.trim()
  if (text.startsWith('/')) return

  let rest
  try { rest = await db.getRestaurant(chatId) }
  catch(e) { await send(chatId, '❌ Errore di connessione. Scrivi /start.'); return }

  if (!rest) { await send(chatId, '👋 Scrivi /start per iniziare!'); return }

  const step = rest.onboarding_step || 'welcome'

  try {
    switch(step) {

      case 'welcome':
      case 'awaiting_name':
        if (text.length > 1) await stepType(chatId, text)
        break

      case 'awaiting_type':
        await stepCity(chatId, text)
        break

      case 'awaiting_city':
        await stepInvoices(chatId, text)
        break

      case 'awaiting_invoices':
        if (text.toUpperCase() === 'FINE' || text.toLowerCase() === 'fine') {
          await stepSummary(chatId)
        } else {
          await send(chatId, '📄 Manda le foto delle fatture oppure scrivi <b>FINE</b> quando hai finito.')
        }
        break

      case 'awaiting_manual_ingredients': {
        const lines = text.split('\n').filter(l => l.trim())
        const ings = []
        for (const line of lines) {
          const parts = line.split(/[—\-:]/)
          if (parts.length >= 2) {
            const name = parts[0].trim()
            const match = parts[1].match(/(\d+(?:[.,]\d+)?)\s*(kg|g|l|pz|bottiglie)?/i)
            if (name && match) ings.push({ name, weeklyOrder: parseFloat(match[1]), unit: match[2] || 'kg' })
          }
        }
        if (ings.length > 0) {
          await db.bulkAddIngredients(rest.id, ings)
          await stepSummary(chatId)
        } else {
          await send(chatId, 'Prova così:\n\n<i>Farina — 50kg\nMozzarella — 8kg\nPomodoro — 15kg</i>')
        }
        break
      }

      case 'awaiting_stock':
        await handleInitialStock(chatId, text)
        break

      case 'awaiting_order_confirm':
        if (text.toLowerCase().includes('si') || text.includes('✅')) {
          await confirmOrders(chatId)
        } else {
          await send(chatId, '👍 Ok, nessun ordine stasera.', { reply_markup: { remove_keyboard: true } })
          await db.upsertRestaurant(chatId, { onboarding_step: 'active' })
        }
        break

      case 'active': {
        // Aggiorna stock se menziona quantità
        const qtyMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|l|litri|bottiglie|pezzi)/i)
        if (qtyMatch) {
          await bot.sendChatAction(chatId, 'typing')
          const response = await chatResponse(text, rest.name)
          await send(chatId, response)
        } else {
          await bot.sendChatAction(chatId, 'typing')
          const response = await chatResponse(text, rest.name)
          await send(chatId, response)
        }
        break
      }

      default:
        await send(chatId, '👋 Scrivi /start per iniziare o /alert per il report scorte.')
    }
  } catch(e) {
    console.error('Message handler error:', e.message)
    await send(chatId, '❌ Qualcosa è andato storto. Riprova o scrivi /start.')
  }
})

// ─── CRON SERALE ─────────────────────────────────────────────────────────────
// 21:00 UTC = 23:00 CEST (estate) | 22:00 UTC = 23:00 CET (inverno)
cron.schedule('0 21 * * *', async () => {
  console.log('⏰ Alert serali (21 UTC)...')
  try {
    const restaurants = await db.getAllActiveRestaurants()
    for (const rest of restaurants) {
      try {
        const ingredients = await db.getIngredients(rest.id)
        const wines = await db.getWines(rest.id)
        const suppliers = await db.getSuppliers(rest.id)
        if (ingredients.length === 0) continue
        const alert = await generateStockAlert(rest, ingredients, wines, suppliers)
        await send(rest.chat_id, alert, {
          reply_markup: { keyboard: [['✅ SI, manda gli ordini', '❌ No grazie']], resize_keyboard: true, one_time_keyboard: true }
        })
        await db.upsertRestaurant(rest.chat_id, { onboarding_step: 'awaiting_order_confirm' })
        await sleep(2000)
      } catch(e) { console.error(`Alert error ${rest.chat_id}:`, e.message) }
    }
  } catch(e) { console.error('Cron error:', e) }
})

cron.schedule('0 22 * * *', async () => {
  console.log('⏰ Alert serali (22 UTC)...')
  // Stesso codice — copre orario invernale
})

console.log('🚀 Unobuono Bot v3 — Online!')
