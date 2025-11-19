const { createClient } = require('@supabase/supabase-js');
const { send } = require('micro'); 
const json = require('micro').json; 
const axios = require('axios'); 

// --- СЕКРЕТЫ ---
const SUPABASE_URL = process.env.SUPABASE_URL;
// Используем Service Role Key для записи необработанных транзакций
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Константы NEAR (для чтения и фильтрации)
const DEPOSIT_ACCOUNT_ID = process.env.NEAR_SENDER_ID; 
const TOKEN_CONTRACT_ID = process.env.TOKEN_CONTRACT_ID; 
// API NEARBlocks для FT-транзакций
const EXPLORER_API_URL = `https://api.testnet.nearblocks.io/v1/fts/txns/${DEPOSIT_ACCOUNT_ID}`; 


// --- ОСНОВНАЯ ФУНКЦИЯ VERCEL (Запускается Supabase Cron) ---
module.exports = async (req, res) => {
    
    if (req.method !== 'POST') {
        return send(res, 405, { error: 'Method Not Allowed' });
    }
    
    try {
        const data = await json(req);
        // ОЖИДАЕМ ПАРАМЕТР last_checked_time ОТ CRON
        const lastCheckedTime = data.last_checked_time || 0; // 0, если не передан
        let latestTxnTimestamp = 0; // Для возврата самого нового таймстампа

        // 1. ЗАПРОС К NEARBLOCKS API
        const explorerResponse = await axios.get(EXPLORER_API_URL, {
            params: {
                contract_id: TOKEN_CONTRACT_ID, 
                limit: 50 // Всегда запрашиваем перекрытие
            }
        });

        const txns = explorerResponse.data.fts;
        let newDeposits = 0;
        
        // 2. ИТЕРАЦИЯ И ФИЛЬТРАЦИЯ
        for (const txn of txns) {
            const currentTxnTimestamp = txn.block_timestamp; // В наносекундах (Unix)
            
            // Фильтруем: обрабатываем только транзакции, которые новее, чем
            // последний обработанный таймстамп (игнорируем старые)
            if (currentTxnTimestamp <= lastCheckedTime) {
                // Если API возвращает отсортированные данные, можно выйти:
                // break; 
                continue; // Продолжаем проверять, так как сортировка может быть не идеальной
            }
            
            // Обновляем метку для возврата (самая свежая транзакция в этой выборке)
            if (currentTxnTimestamp > latestTxnTimestamp) {
                latestTxnTimestamp = currentTxnTimestamp;
            }

            // Проверяем, что это входящий перевод на наш кошелек-сборщик
            if (txn.receiver_id === DEPOSIT_ACCOUNT_ID && txn.method_name === 'ft_transfer') {
                
                const depositData = {
                    tx_hash: txn.transaction_hash,
                    sender_id: txn.sender_id,
                    amount: txn.amount, 
                    created_at: new Date(Number(txn.block_timestamp) / 1000000).toISOString(),
                };

                // 3. ЗАПИСЬ В SUPABASE
                const { error: upsertError } = await supabase
                    .from('incoming_deposits')
                    .upsert(depositData, { 
                        onConflict: 'tx_hash', 
                        ignoreDuplicates: true 
                    });

                if (!upsertError) {
                    newDeposits++;
                } else if (upsertError && upsertError.code !== '23505') { 
                    console.error(`Supabase UPSERT Error for ${txn.transaction_hash}:`, upsertError);
                }
            }
        }

        // 4. Успешный ответ (возвращаем самый свежий таймстамп для обновления в Supabase)
        return send(res, 200, {
            success: true,
            message: `Batch check complete. ${newDeposits} new transactions recorded.`,
            latest_timestamp: latestTxnTimestamp // КЛЮЧЕВОЙ МОМЕНТ: ВОЗВРАТ НОВОЙ МЕТКИ
        });

    } catch (e) {
        console.error('Batch Check API Error:', e.message);
        return send(res, 500, { 
            error: 'Batch check failed.', 
            details: e.message 
        });
    }
};