// db.js — Database layer con Supabase
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

async function getRestaurant(chatId) {
  const { data } = await supabase
    .from('restaurants')
    .select('*')
    .eq('chat_id', String(chatId))
    .single()
  return data
}

async function upsertRestaurant(chatId, updates) {
  const { data, error } = await supabase
    .from('restaurants')
    .upsert(
      { chat_id: String(chatId), ...updates, updated_at: new Date() },
      { onConflict: 'chat_id' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

async function updateRestaurant(chatId, updates) {
  return upsertRestaurant(chatId, updates)
}

async function getIngredients(restaurantId) {
  const { data } = await supabase
    .from('ingredients')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('sort_order')
  return data || []
}

async function bulkAddIngredients(restaurantId, ingredients) {
  const rows = ingredients.map((ing, i) => ({
    restaurant_id: restaurantId,
    name: ing.name,
    weekly_order: ing.weeklyOrder,
    unit: ing.unit || 'kg',
    current_stock: ing.weeklyOrder,
    sort_order: i
  }))
  const { data, error } = await supabase.from('ingredients').insert(rows).select()
  if (error) throw error
  return data
}

async function updateIngredientStock(restaurantId, ingredientName, newStock, reason = 'manual') {
  const { data: current } = await supabase
    .from('ingredients').select('current_stock')
    .eq('restaurant_id', restaurantId)
    .ilike('name', `%${ingredientName}%`)
    .single()

  await supabase.from('ingredients')
    .update({ current_stock: newStock, last_updated: new Date() })
    .eq('restaurant_id', restaurantId)
    .ilike('name', `%${ingredientName}%`)

  await supabase.from('stock_updates').insert({
    restaurant_id: restaurantId,
    ingredient_name: ingredientName,
    old_stock: current?.current_stock,
    new_stock: newStock,
    reason
  })
}

async function getWines(restaurantId) {
  const { data } = await supabase
    .from('wines').select('*')
    .eq('restaurant_id', restaurantId)
  return data || []
}

async function bulkAddWines(restaurantId, wines) {
  const rows = wines.map(w => ({
    restaurant_id: restaurantId,
    name: w.name,
    normal_stock: w.normalStock || 12,
    current_stock: w.normalStock || 12,
    weekly_avg: w.weeklyAvg || 2
  }))
  const { data, error } = await supabase.from('wines').insert(rows).select()
  if (error) throw error
  return data
}

async function updateWineStock(restaurantId, wineName, newStock) {
  await supabase.from('wines')
    .update({ current_stock: newStock, last_updated: new Date() })
    .eq('restaurant_id', restaurantId)
    .ilike('name', `%${wineName}%`)
}

async function getSuppliers(restaurantId) {
  const { data } = await supabase
    .from('suppliers').select('*')
    .eq('restaurant_id', restaurantId)
  return data || []
}

async function addSupplier(restaurantId, supplier) {
  const { data, error } = await supabase
    .from('suppliers')
    .insert({ restaurant_id: restaurantId, ...supplier })
    .select().single()
  if (error) throw error
  return data
}

async function addOrder(restaurantId, items) {
  const { data, error } = await supabase
    .from('orders')
    .insert({ restaurant_id: restaurantId, items, status: 'sent' })
    .select().single()
  if (error) throw error
  for (const item of items) {
    if (item.restockTo) {
      await updateIngredientStock(restaurantId, item.name, item.restockTo, 'order')
    }
  }
  return data
}

async function getOrders(restaurantId, limit = 10) {
  const { data } = await supabase
    .from('orders').select('*')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return data || []
}

async function bulkAddMenuItems(restaurantId, items) {
  const rows = items.map(item => ({
    restaurant_id: restaurantId,
    name: item.nome || item.name,
    category: item.categoria || item.category,
    price: item.prezzo || item.price
  }))
  await supabase.from('menu_items').insert(rows)
}

async function getAllActiveRestaurants() {
  const { data } = await supabase
    .from('restaurants').select('*')
    .eq('onboarding_complete', true)
  return data || []
}

async function getFullContext(restaurantId) {
  const [ingredients, wines, suppliers, orders] = await Promise.all([
    getIngredients(restaurantId),
    getWines(restaurantId),
    getSuppliers(restaurantId),
    getOrders(restaurantId, 5)
  ])
  return { ingredients, wines, suppliers, recentOrders: orders }
}

module.exports = {
  supabase,
  getRestaurant,
  upsertRestaurant,
  updateRestaurant,
  getIngredients,
  bulkAddIngredients,
  updateIngredientStock,
  getWines,
  bulkAddWines,
  updateWineStock,
  getSuppliers,
  addSupplier,
  addOrder,
  getOrders,
  bulkAddMenuItems,
  getAllActiveRestaurants,
  getFullContext
}
