// invoice-reader.js — Lettura fatture per onboarding avanzato
// Il ristoratore manda foto delle fatture → l'AI estrae tutto automaticamente

const Anthropic = require('@anthropic-ai/sdk')
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Estrae dati strutturati da una foto di fattura
async function extractInvoiceData(imageBase64, mediaType = 'image/jpeg') {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: imageBase64 }
        },
        {
          type: 'text',
          text: `Sei un assistente specializzato nell'analisi di fatture per ristoranti italiani.
          
Analizza questa fattura e estrai TUTTI i dati strutturati.
Rispondi SOLO con JSON valido, nessun testo aggiuntivo:

{
  "fornitore": {
    "nome": "...",
    "telefono": "...",
    "email": "...",
    "piva": "..."
  },
  "data_fattura": "YYYY-MM-DD",
  "numero_fattura": "...",
  "prodotti": [
    {
      "nome": "...",
      "quantita": 0,
      "unita": "kg|l|pz|casse|bottiglie|sacche",
      "prezzo_unitario": 0,
      "prezzo_totale": 0,
      "categoria": "carne|pesce|verdura|formaggi|salumi|pasta|farina|olio|vino|birra|altro"
    }
  ],
  "totale": 0,
  "note": "eventuali note rilevanti"
}`
        }
      ]
    }]
  })

  try {
    const text = response.content[0].text.replace(/```json|```/g, '').trim()
    return JSON.parse(text)
  } catch (err) {
    console.error('Invoice parse error:', err)
    return null
  }
}

// Analizza più fatture e costruisce il profilo completo del ristorante
async function analyzeMultipleInvoices(invoices) {
  // Aggrega tutti i prodotti per fornitore
  const supplierMap = {}
  const productHistory = {}

  for (const invoice of invoices) {
    if (!invoice) continue

    const supplierName = invoice.fornitore?.nome
    if (!supplierName) continue

    // Aggiungi fornitore
    if (!supplierMap[supplierName]) {
      supplierMap[supplierName] = {
        ...invoice.fornitore,
        prodotti: [],
        ordini: 0,
        ultimo_ordine: invoice.data_fattura
      }
    }
    supplierMap[supplierName].ordini++

    // Aggiungi prodotti
    for (const prodotto of invoice.prodotti || []) {
      const key = `${supplierName}::${prodotto.nome}`
      if (!productHistory[key]) {
        productHistory[key] = {
          nome: prodotto.nome,
          fornitore: supplierName,
          unita: prodotto.unita,
          categoria: prodotto.categoria,
          prezzi: [],
          quantita: [],
          ordini: 0
        }
      }
      productHistory[key].prezzi.push(prodotto.prezzo_unitario)
      productHistory[key].quantita.push(prodotto.quantita)
      productHistory[key].ordini++
    }
  }

  // Calcola medie e frequenze
  const ingredients = Object.values(productHistory).map(p => {
    const avgPrice = p.prezzi.reduce((a, b) => a + b, 0) / p.prezzi.length
    const avgQty = p.quantita.reduce((a, b) => a + b, 0) / p.quantita.length
    const lastPrice = p.prezzi[p.prezzi.length - 1]
    const priceChange = lastPrice - avgPrice
    const priceChangePct = avgPrice > 0 ? (priceChange / avgPrice * 100) : 0

    return {
      name: p.nome,
      supplier: p.fornitore,
      unit: p.unita,
      category: p.categoria,
      avgPrice: Math.round(avgPrice * 100) / 100,
      lastPrice: Math.round(lastPrice * 100) / 100,
      priceChangePct: Math.round(priceChangePct * 10) / 10,
      weeklyOrder: Math.round(avgQty * 10) / 10,
      orderFrequency: p.ordini,
      priceAlert: Math.abs(priceChangePct) > 10
    }
  })

  return {
    suppliers: Object.values(supplierMap),
    ingredients,
    summary: buildSummary(ingredients, Object.values(supplierMap))
  }
}

function buildSummary(ingredients, suppliers) {
  const priceAlerts = ingredients.filter(i => i.priceAlert)
  const topCosts = ingredients
    .sort((a, b) => (b.avgPrice * b.weeklyOrder) - (a.avgPrice * a.weeklyOrder))
    .slice(0, 5)

  return {
    totalIngredients: ingredients.length,
    totalSuppliers: suppliers.length,
    priceAlerts: priceAlerts.map(i => ({
      name: i.name,
      change: `${i.priceChangePct > 0 ? '+' : ''}${i.priceChangePct}%`
    })),
    topCostIngredients: topCosts.map(i => ({
      name: i.name,
      weeklyEstimate: `€${Math.round(i.avgPrice * i.weeklyOrder * 10) / 10}`
    }))
  }
}

// Formatta il risultato per il messaggio Telegram
function formatInvoiceResult(invoiceData) {
  if (!invoiceData) return '❌ Non sono riuscito a leggere questa fattura. Prova con una foto più nitida.'

  let msg = `✅ *Fattura letta!*\n\n`
  msg += `🏢 *Fornitore:* ${invoiceData.fornitore?.nome || 'N/D'}\n`
  if (invoiceData.fornitore?.telefono) msg += `📞 ${invoiceData.fornitore.telefono}\n`
  msg += `📅 Data: ${invoiceData.data_fattura || 'N/D'}\n\n`

  msg += `*Prodotti trovati (${invoiceData.prodotti?.length || 0}):*\n`
  for (const p of invoiceData.prodotti || []) {
    msg += `• ${p.nome}: ${p.quantita}${p.unita} @ €${p.prezzo_unitario}/${p.unita}\n`
  }

  msg += `\n💰 *Totale: €${invoiceData.totale || 'N/D'}*\n\n`
  msg += `Salvo questi dati nel tuo profilo? (SI/NO)`

  return msg
}

function formatAnalysisResult(analysis) {
  let msg = `📊 *Analisi fatture completata!*\n\n`
  msg += `Ho trovato:\n`
  msg += `• ${analysis.summary.totalIngredients} prodotti da ${analysis.summary.totalSuppliers} fornitori\n\n`

  if (analysis.summary.priceAlerts.length > 0) {
    msg += `⚠️ *Aumenti di prezzo rilevati:*\n`
    for (const alert of analysis.summary.priceAlerts) {
      msg += `• ${alert.name}: ${alert.change}\n`
    }
    msg += '\n'
  }

  msg += `💰 *Top 5 voci di costo settimanali:*\n`
  for (const item of analysis.summary.topCostIngredients) {
    msg += `• ${item.name}: ~${item.weeklyEstimate}/sett.\n`
  }

  msg += '\nImporto tutto nel tuo magazzino? (SI/NO)'
  return msg
}

module.exports = {
  extractInvoiceData,
  analyzeMultipleInvoices,
  formatInvoiceResult,
  formatAnalysisResult
}
