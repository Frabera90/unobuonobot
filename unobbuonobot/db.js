const { createClient } = require('@supabase/supabase-js');

// Inizializza Supabase usando le variabili d'ambiente di Railway
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = {
  // Recupera il ristorante o lo crea se non esiste[cite: 1]
  async getRestaurant(chatId) {
    let { data, error } = await supabase
      .from('restaurants')
      .select('*')
      .eq('chat_id', chatId)
      .single();

    if (error && error.code === 'PGRST116') { // Non trovato
      const newRest = { chat_id: chatId, profile: {}, ingredients: [], wines: [], stock: {}, order_history: [] };
      const { data: created } = await supabase.from('restaurants').insert([newRest]).select().single();
      return created;
    }
    return data;
  },

  // Aggiorna i dati su Supabase[cite: 1]
  async updateRestaurant(chatId, updateData) {
    // Mappatura nomi variabili bot.js -> colonne database
    const mappedData = {};
    if (updateData.step) mappedData.step = updateData.step;
    if (updateData.profile) mappedData.profile = updateData.profile;
    if (updateData.menu) mappedData.menu = updateData.menu;
    if (updateData.ingredients) mappedData.ingredients = updateData.ingredients;
    if (updateData.wines) mappedData.wines = updateData.wines;
    if (updateData.suppliers) mappedData.suppliers = updateData.suppliers;
    if (updateData.stock) mappedData.stock = updateData.stock;
    if (updateData.onboardingComplete !== undefined) mappedData.onboarding_complete = updateData.onboarding_complete;

    const { data, error } = await supabase
      .from('restaurants')
      .update(mappedData)
      .eq('chat_id', chatId);
    
    return data;
  },

  // Aggiorna lo stock[cite: 1]
  async updateStock(chatId, itemName, quantity) {
    const rest = await this.getRestaurant(chatId);
    const newStock = { ...rest.stock, [itemName]: quantity };
    await this.updateRestaurant(chatId, { stock: newStock });
  },

  // Aggiunge un ordine[cite: 1]
  async addOrder(chatId, order) {
    const rest = await this.getRestaurant(chatId);
    const history = [...(rest.order_history || []), { date: new Date().toISOString(), ...order }];
    await this.updateRestaurant(chatId, { orderHistory: history });
  },

  // Recupera tutti per il report delle 23:00[cite: 1]
  async getAllRestaurants() {
    const { data } = await supabase.from('restaurants').select('*');
    return data || [];
  }
};
