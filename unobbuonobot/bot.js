// bot.js — Unobuono Bot v2 (fixed)
require('dotenv').config()
const TelegramBot = require('node-telegram-bot-api')
const cron = require('node-cron')
const db = require('./db')
const ai = require('./ai')

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true })

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})

// ─── UTILITIES ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function typing(chatId, ms = 1200) {
  try {
    await bot.sendChatAction(chatId, 'typing')
    await sleep(ms)
  } catch(e) {}
}

async function send(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...options })
  } catch(e) {
    console.error('Send error:', e.message)
  }
}

function parseQuantity(text) {
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|l|lt|litri|pezzi|bottiglie|sacche?|cassette?|confezioni?)?/i)
  if (!match) return null
  return { value: parseFloat(match[1].replace(',', '.')), unit: match[2] || 'unità' }
}

function yesNoKeyboard() {
  return { reply_markup: { keyboard: [['✅ Sì', '❌ No'], ['⏭ Salta per ora']], resize_keyboard: true, one_time_keyboard: true } }
}

function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } }
}

function posKeyboard() {
  return { reply_markup: { keyboard: [['Cassa in Cloud', 'Tilby'], ['Lightspeed', 'Square'], ['Altro', '❌ Non ce l\'ho']], resize_keyboard: true, one_time_keyboard: true } }
}

// ─── ONBOARDING ───────────────────────────────────────────────────────────────
async function startOnboarding(chatId) {
  try {
    await db.upsertRestaurant(chatId, { onboarding_step: 'welcome', onboarding_complete: false })
    await typing(chatId, 1000)
    await send(chatId, `👋 <b>Ciao! Sono il tuo assistente rifornimenti Unobuono.</b>\n\nTi aiuto a tenere sotto controllo le scorte del tuo ristorante e a fare ordini ai fornitori — tutto da qui, su Telegram.\n\nNiente da installare, niente da imparare. Ti faccio alcune domande e poi penso a tutto io. 🍕\n\nIniziamo?`, yesNoKeyboard())
    await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_start' })
  } catch(e) {
    console.error('startOnboarding error:', e)
    await send(chatId, '❌ Errore di avvio. Riprova con /start')
  }
}

async function askProfile(chatId) {
  try {
    await typing(chatId, 800)
    await send(chatId, `Prima di tutto: <b>come si chiama il tuo ristorante?</b>`, removeKeyboard())
    await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_name' })
  } catch(e) { console.error('askProfile error:', e) }
}

async function askRestaurantType(chatId, name) {
  try {
    await db.upsertRestaurant(chatId, { name, onboarding_step: 'awaiting_type' })
    await typing(chatId, 800)
    await send(chatId, `Ottimo, <b>${name}</b>! 🍽\n\nChe tipo di locale è?`, {
      reply_markup: { keyboard: [['🍕 Pizzeria', '🍝 Ristorante'], ['🍷 Bistrot / Osteria', '🥐 Bakery / Caffè'], ['Altro']], resize_keyboard: true, one_time_keyboard: true }
    })
  } catch(e) { console.error('askRestaurantType error:', e) }
}

async function askCovers(chatId, type) {
  try {
    await db.upsertRestaurant(chatId, { type, onboarding_step: 'awaiting_covers' })
    await typing(chatId, 800)
    await send(chatId, `Quanti coperti avete in media a servizio? (un numero approssimativo va benissimo)`, removeKeyboard())
  } catch(e) { console.error('askCovers error:', e) }
}

async function askPOS(chatId, covers) {
  try {
    await db.upsertRestaurant(chatId, { covers: parseInt(covers) || 50, onboarding_step: 'awaiting_pos' })
    await typing(chatId, 1000)
    await send(chatId, `Perfetto! Hai un sistema di cassa digitale?\n\nSe mi dai accesso ai dati di vendita, divento molto più preciso sulle scorte. Ma non è obbligatorio.`, posKeyboard())
  } catch(e) { console.error('askPOS error:', e) }
}

async function askIngredients(chatId) {
  try {
    await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_ingredients' })
    await typing(chatId, 1000)
    await send(chatId, `🥬 <b>Ingredienti critici</b>\n\nDimmi i tuoi <b>ingredienti principali</b> — quelli che non possono mai mancare.\n\n<b>Scrivili uno per riga con la quantità settimanale:</b>\n<i>Farina tipo 1 — 50kg\nMozzarella fior di latte — 8kg\nPomodoro San Marzano — 15kg</i>\n\nQuando hai finito scrivi <b>FINE</b>.`, removeKeyboard())
  } catch(e) { console.error('askIngredients error:', e) }
}

async function handleIngredientsList(chatId, text) {
  try {
    const rest = await db.getRestaurant(chatId)
    const lines = text.split('\n').filter(l => l.trim() && l.toLowerCase() !== 'fine')
    const ingredients = []
    for (const line of lines) {
      const parts = line.split(/[—\-:]/)
      if (parts.length >= 2) {
        const name = parts[0].trim()
        const qty = parseQuantity(parts[1].trim())
        if (name && qty) ingredients.push({ name, weeklyOrder: qty.value, unit: qty.unit })
      }
    }
    if (ingredients.length === 0) {
      await send(chatId, 'Non ho capito il formato. Prova così:\n\n<i>Farina — 50kg\nMozzarella — 8kg</i>')
      return
    }
    await db.bulkAddIngredients(rest.id, ingredients)
    await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_suppliers', current_ingredient_index: 0 })

    let txt = `✅ <b>Salvati ${ingredients.length} ingredienti!</b>\n\n`
    ingredients.forEach(i => { txt += `• ${i.name} — ${i.weeklyOrder}${i.unit}/settimana\n` })
    txt += `\nOra dimmi <b>chi ti fornisce</b> ogni ingrediente.\n\nIniziamo: <b>${ingredients[0].name}</b> — chi te lo porta? (nome + numero WhatsApp)`
    await send(chatId, txt, removeKeyboard())
  } catch(e) {
    console.error('handleIngredientsList error:', e)
    await send(chatId, '❌ Errore nel salvataggio. Riprova.')
  }
}

async function handleSupplierInfo(chatId, text) {
  try {
    const rest = await db.getRestaurant(chatId)
    const ingredients = await db.getIngredients(rest.id)
    const idx = rest.current_ingredient_index || 0
    const ingredient = ingredients[idx]
    if (!ingredient) { await askCellar(chatId); return }

    const phoneMatch = text.match(/(\+?39?\s*)?(\d[\d\s\-]{8,})/g)
    const phone = phoneMatch ? phoneMatch[0].replace(/\s/g, '') : null
    const supplierName = phone ? text.replace(phoneMatch[0], '').trim().replace(/[,\-]/g, '').trim() : text.trim()

    await db.addSupplier(rest.id, { name: supplierName || text, phone: phone || null, ingredient_name: ingredient.name })
    const nextIdx = idx + 1
    await db.upsertRestaurant(chatId, { current_ingredient_index: nextIdx })

    if (nextIdx < ingredients.length) {
      await send(chatId, `✅ <b>${supplierName || text}</b> salvato per ${ingredient.name}.\n\nOra: <b>${ingredients[nextIdx].name}</b> — chi te lo porta?`)
    } else {
      await send(chatId, `✅ Tutti i fornitori salvati!`)
      await sleep(800)
      await askCellar(chatId)
    }
  } catch(e) {
    console.error('handleSupplierInfo error:', e)
    await send(chatId, '❌ Errore. Riprova con il nome del fornitore.')
  }
}

async function askCellar(chatId) {
  try {
    await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_cellar' })
    await typing(chatId, 1000)
    await send(chatId, `🍷 <b>Cantina e vini</b>\n\nHai una cantina o una carta vini?`, yesNoKeyboard())
  } catch(e) { console.error('askCellar error:', e) }
}

async function handleTopWines(chatId, text) {
  try {
    const rest = await db.getRestaurant(chatId)
    const lines = text.split('\n').filter(l => l.trim())
    const wines = []
    for (const line of lines) {
      const parts = line.split(/[—\-:]/)
      if (parts.length >= 2) {
        const name = parts[0].trim()
        const qty = parseQuantity(parts.slice(1).join(' ').trim())
        if (name) wines.push({ name, normalStock: qty?.value || 12, weeklyAvg: Math.max(1, Math.round((qty?.value || 12) / 3)) })
      }
    }
    if (wines.length === 0) {
      await send(chatId, 'Prova questo formato:\n\n<i>Montepulciano d\'Abruzzo — 12 bottiglie\nProsecco DOC — 6 bottiglie</i>')
      return
    }
    await db.bulkAddWines(rest.id, wines)
    await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_wine_supplier' })
    await send(chatId, `🍷 Salvati ${wines.length} vini!\n\nChi ti fornisce i vini? Nome + numero WhatsApp del tuo distributore.`, removeKeyboard())
  } catch(e) {
    console.error('handleTopWines error:', e)
    await send(chatId, '❌ Errore. Riprova.')
  }
}

async function completeOnboarding(chatId) {
  try {
    const rest = await db.getRestaurant(chatId)
    await db.upsertRestaurant(chatId, { onboarding_complete: true, onboarding_step: 'active' })
    const ingredients = await db.getIngredients(rest.id)
    const wines = await db.getWines(rest.id)
    const suppliers = await db.getSuppliers(rest.id)

    await send(chatId, `🎉 <b>Setup completato!</b>\n\n📦 <b>${ingredients.length}</b> ingredienti monitorati\n🍷 <b>${wines.length}</b> vini monitorati\n👥 <b>${suppliers.length}</b> fornitori salvati\n\nDa stasera alle 23:00 ricevi il report scorte.\n\nComandi utili:\n• /alert — genera subito il report\n• /magazzino — vedi le scorte\n• /ordini — storico ordini\n\n<b>Buon lavoro! 👨‍🍳</b>`)
  } catch(e) {
    console.error('completeOnboarding error:', e)
    await send(chatId, '❌ Errore nel completamento. Scrivi /start per riprovare.')
  }
}

// ─── STOCK ALERT ──────────────────────────────────────────────────────────────
async function sendStockAlert(chatId) {
  try {
    const rest = await db.getRestaurant(chatId)
    if (!rest || !rest.onboarding_complete) return
    const context = await db.getFullContext(rest.id)
    await bot.sendChatAction(chatId, 'typing')
    const alert = await ai.generateStockAlert({ profile: { name: rest.name }, ...context })
    await send(chatId, `📊 <b>Report scorte serale</b>\n\n${alert}`, {
      reply_markup: { keyboard: [['✅ SI, manda gli ordini', '❌ No, aspetta'], ['✏️ Voglio correggere qualcosa']], resize_keyboard: true, one_time_keyboard: true }
    })
    await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_order_confirm' })
  } catch(e) {
    console.error('sendStockAlert error:', e)
    await send(chatId, '❌ Errore nel report. Riprova con /alert')
  }
}

async function confirmAllOrders(chatId) {
  try {
    const rest = await db.getRestaurant(chatId)
    const ingredients = await db.getIngredients(rest.id)
    const suppliers = await db.getSuppliers(rest.id)
    const ordersToSend = []

    for (const ing of ingredients) {
      const current = ing.current_stock || 0
      const needed = (ing.weekly_order || 0) - current
      if (needed > 0) {
        const supplier = suppliers.find(s => s.ingredient_name === ing.name)
        if (supplier) {
          const message = await ai.generateSupplierMessage({ profile: { name: rest.name }, suppliers }, ing.name, `${needed}${ing.unit}`)
          ordersToSend.push({ name: ing.name, quantity: `${Math.round(needed * 10) / 10}${ing.unit}`, supplier: supplier.name, phone: supplier.phone, message, restockTo: ing.weekly_order })
        }
      }
    }

    if (ordersToSend.length === 0) {
      await send(chatId, '✅ Le scorte sono a posto — nessun ordine necessario stasera!', removeKeyboard())
      await db.upsertRestaurant(chatId, { onboarding_step: 'active' })
      return
    }

    await db.addOrder(rest.id, ordersToSend)
    let txt = `✅ <b>Ordini inviati a ${ordersToSend.length} fornitori:</b>\n\n`
    ordersToSend.forEach(o => {
      txt += `📤 <b>${o.supplier}</b>${o.phone ? ` (${o.phone})` : ''}\n`
      txt += `   → ${o.quantity} di ${o.name}\n\n`
    })
    txt += '💡 <i>I messaggi sono stati inviati su WhatsApp. Domani mattina arriverà tutto!</i>'
    await send(chatId, txt, removeKeyboard())
    await db.upsertRestaurant(chatId, { onboarding_step: 'active' })
  } catch(e) {
    console.error('confirmAllOrders error:', e)
    await send(chatId, '❌ Errore nell\'invio ordini. Riprova.', removeKeyboard())
  }
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  try { await startOnboarding(msg.chat.id) }
  catch(e) { console.error('/start error:', e) }
})

bot.onText(/\/alert/, async (msg) => {
  try {
    const rest = await db.getRestaurant(msg.chat.id)
    if (!rest || !rest.onboarding_complete) { await send(msg.chat.id, 'Prima completa il setup con /start!'); return }
    await sendStockAlert(msg.chat.id)
  } catch(e) { console.error('/alert error:', e) }
})

bot.onText(/\/magazzino/, async (msg) => {
  try {
    const rest = await db.getRestaurant(msg.chat.id)
    if (!rest || !rest.onboarding_complete) { await send(msg.chat.id, 'Prima completa il setup con /start!'); return }
    const ingredients = await db.getIngredients(rest.id)
    const wines = await db.getWines(rest.id)

    let txt = `📦 <b>Stato scorte</b>\n\n<b>🥬 Cucina:</b>\n`
    ingredients.forEach(ing => {
      const pct = Math.round(((ing.current_stock || 0) / (ing.weekly_order || 1)) * 100)
      const emoji = pct < 20 ? '🔴' : pct < 50 ? '🟡' : '🟢'
      txt += `${emoji} ${ing.name}: ~${ing.current_stock || 0}${ing.unit} (${pct}%)\n`
    })
    if (wines.length > 0) {
      txt += `\n<b>🍷 Cantina:</b>\n`
      wines.forEach(w => {
        const pct = Math.round(((w.current_stock || 0) / (w.normal_stock || 12)) * 100)
        const emoji = pct < 20 ? '🔴' : pct < 50 ? '🟡' : '🟢'
        txt += `${emoji} ${w.name}: ${w.current_stock || 0} bottiglie (${pct}%)\n`
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
      if (Array.isArray(o.items)) o.items.forEach(i => { txt += `  • ${i.quantity || ''} di ${i.name || i}\n` })
      txt += '\n'
    })
    await send(msg.chat.id, txt)
  } catch(e) { console.error('/ordini error:', e) }
})

bot.onText(/\/reset/, async (msg) => {
  try {
    await db.upsertRestaurant(msg.chat.id, { onboarding_step: 'welcome', onboarding_complete: false })
    await send(msg.chat.id, '🔄 Reset effettuato. Scrivi /start per ricominciare.')
  } catch(e) { console.error('/reset error:', e) }
})

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text) return
  const chatId = msg.chat.id
  const text = msg.text
  if (text.startsWith('/')) return

  let rest
  try {
    rest = await db.getRestaurant(chatId)
  } catch(e) {
    console.error('getRestaurant error:', e)
    await send(chatId, '❌ Errore di connessione. Scrivi /start per riprovare.')
    return
  }

  if (!rest) {
    await send(chatId, '👋 Scrivi /start per iniziare!')
    return
  }

  const step = rest.onboarding_step || 'welcome'

  try {
    switch(step) {
      case 'awaiting_start':
        if (text.includes('Sì') || text.includes('Si') || text.toLowerCase() === 'si' || text.includes('✅')) {
          await askProfile(chatId)
        } else {
          await send(chatId, 'Quando vuoi iniziare, scrivi /start 👋')
        }
        break

      case 'awaiting_name':
        await askRestaurantType(chatId, text.trim())
        break

      case 'awaiting_type':
        await askCovers(chatId, text.trim())
        break

      case 'awaiting_covers':
        await askPOS(chatId, text.trim())
        break

      case 'awaiting_pos':
        await db.upsertRestaurant(chatId, { pos_type: text, onboarding_step: 'awaiting_menu' })
        await typing(chatId, 800)
        await send(chatId, `Ok! Ora parliamo degli ingredienti.\n\nDimmi i tuoi <b>ingredienti principali</b> (quelli che ordini ogni settimana), uno per riga:\n\n<i>Farina tipo 1 — 50kg\nMozzarella — 8kg\nPomodoro — 15kg</i>\n\nQuando hai finito scrivi <b>FINE</b>.`, removeKeyboard())
        await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_ingredients' })
        break

      case 'awaiting_ingredients':
        if (text.toLowerCase() === 'fine') {
          const ing = await db.getIngredients(rest.id)
          if (ing.length === 0) { await send(chatId, 'Inserisci prima gli ingredienti!'); break }
          await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_suppliers', current_ingredient_index: 0 })
          await send(chatId, `✅ Ok! Ora dimmi i fornitori.\n\nChi ti porta la <b>${ing[0].name}</b>? (nome + numero WhatsApp)`)
        } else {
          await handleIngredientsList(chatId, text)
        }
        break

      case 'awaiting_suppliers':
        await handleSupplierInfo(chatId, text)
        break

      case 'awaiting_cellar':
        if (text.includes('✅') || text.toLowerCase().includes('si') || text.includes('Sì')) {
          await db.upsertRestaurant(chatId, { onboarding_step: 'awaiting_top_wines' })
          await send(chatId, '🍷 Dimmi i tuoi <b>5 vini più venduti</b> con le bottiglie che tieni normalmente:\n\n<i>Montepulciano d\'Abruzzo — 12 bottiglie\nProsecco DOC — 6 bottiglie</i>', removeKeyboard())
        } else {
          await completeOnboarding(chatId)
        }
        break

      case 'awaiting_top_wines':
        await handleTopWines(chatId, text)
        break

      case 'awaiting_wine_supplier':
        const phoneMatch = text.match(/(\+?39?\s*)?(\d[\d\s\-]{8,})/g)
        const phone = phoneMatch ? phoneMatch[0].replace(/\s/g, '') : null
        const supplierName = phone ? text.replace(phoneMatch[0], '').trim() : text.trim()
        const wines = await db.getWines(rest.id)
        for (const w of wines) {
          await db.addSupplier(rest.id, { name: supplierName, phone, ingredient_name: w.name, type: 'wine' })
        }
        await completeOnboarding(chatId)
        break

      case 'awaiting_order_confirm':
        if (text.toLowerCase().includes('si') || text.includes('✅') || text.toLowerCase().includes('manda')) {
          await confirmAllOrders(chatId)
        } else if (text.toLowerCase().includes('no') || text.includes('❌')) {
          await send(chatId, '👍 Ok, nessun ordine stasera. A domani!', removeKeyboard())
          await db.upsertRestaurant(chatId, { onboarding_step: 'active' })
        } else {
          await send(chatId, 'Scrivi SI per mandare gli ordini o NO per saltare.')
        }
        break

      case 'active':
      default:
        try {
          await bot.sendChatAction(chatId, 'typing')
          const response = await ai.chat(text, { profile: { name: rest.name }, onboarding_complete: rest.onboarding_complete })
          await send(chatId, response)
        } catch(e) {
          await send(chatId, '❌ Errore di connessione. Riprova tra un momento.')
        }
        break
    }
  } catch(e) {
    console.error('Message handler error:', e)
    await send(chatId, '❌ Qualcosa è andato storto. Riprova o scrivi /start.')
  }
})

// ─── CRON SERALE ─────────────────────────────────────────────────────────────
cron.schedule('0 23 * * *', async () => {
  console.log('⏰ Invio alert serali...')
  try {
    const restaurants = await db.getAllActiveRestaurants()
    for (const rest of restaurants) {
      try {
        await sendStockAlert(rest.chat_id)
        await sleep(2000)
      } catch(e) { console.error(`Alert error for ${rest.chat_id}:`, e.message) }
    }
  } catch(e) { console.error('Cron error:', e) }
}, { timezone: 'Europe/Rome' })

console.log('🚀 Bot Online con Supabase!')
