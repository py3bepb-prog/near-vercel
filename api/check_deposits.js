const { createClient } = require('@supabase/supabase-js');
const { send } = require('micro'); 
const json = require('micro').json; 
const axios = require('axios'); 

// --- СЕКРЕТЫ И КОНСТАНТЫ ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Наш кошелек, на который приходят депозиты (Используется NEAR_SENDER_ID)
const DEPOSIT_ACCOUNT_ID = process.env.NEAR_SENDER_ID; 

// ID контракта токена (TOKEN_CONTRACT_ID)
const TOKEN_CONTRACT_ID = process.env.TOKEN_CONTRACT_ID; 

// ИСПРАВЛЕННЫЙ API: Используем рабочий домен (api-testnet) и путь /v1/account/[CONTRACT_ID]/txns
const EXPLORER_API_URL = `https://api-testnet.nearblocks.io/v1/account/${TOKEN_CONTRACT_ID}/txns`; 


// --- ОСНОВНАЯ ФУНКЦИЯ VERCEL ---
module.exports = async (req, res) => {
    
    if (req.method !== 'POST') {
        return send(res, 405, { error: 'Method Not Allowed' });
    }
    
    try {
        const data = await json(req);
        // lastCheckedTime в наносекундах (BigInt)
        const lastCheckedTime = BigInt(data.last_checked_time || 0);
        let latestTxnTimestamp = lastCheckedTime; 

        // 1. ЗАПРОС К NEARBLOCKS API
        const explorerResponse = await axios.get(EXPLORER_API_URL, {
            params: {
                limit: 50, 
                order: 'desc' 
            }
        });

        // 2. ИТЕРАЦИЯ И ФИЛЬТРАЦИЯ
        const txns = explorerResponse.data.txns || [];
        let newDeposits = 0;
        
        for (const txn of txns) {
            const currentTxnTimestamp = BigInt(txn.block_timestamp); 
            
            // Фильтр 1: По времени
            if (currentTxnTimestamp <= lastCheckedTime) {
                break; 
            }
            
            // Обновляем метку
            if (currentTxnTimestamp > latestTxnTimestamp) {
                latestTxnTimestamp = currentTxnTimestamp;
            }

            // Ищем FUNCTION_CALL с методом 'ft_transfer'
            const ftTransferAction = txn.actions.find(
                a => a.action === 'FUNCTION_CALL' && a.method === 'ft_transfer'
            );

            if (ftTransferAction) {
                try {
                    // Аргументы ft_transfer находятся в JSON-строке
                    const args = JSON.parse(ftTransferAction.args);
                    
                    // Условие ВХОДЯЩЕГО ДЕПОЗИТА: args.receiver_id должен быть наш кошелек-сборщик (DEPOSIT_ACCOUNT_ID)
                    if (args.receiver_id === DEPOSIT_ACCOUNT_ID) {
                        
                        const depositData = {
                            tx_hash: txn.transaction_hash,
                            sender_id: txn.predecessor_account_id, // Отправитель транзакции
                            amount: args.amount, // Сумма из аргументов
                            created_at: new Date(Number(currentTxnTimestamp) / 1000000).toISOString(),
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
                } catch (e) {
                    console.error(`Error parsing args for txn ${txn.transaction_hash}:`, e.message);
                }
            }
        }

        // 4. Успешный ответ
        return send(res, 200, {
            success: true,
            message: `Batch check complete. ${newDeposits} new transactions recorded.`,
            latest_timestamp: latestTxnTimestamp.toString() 
        });

    } catch (e) {
        console.error('Batch Check API Error:', e.message);
        return send(res, 500, { 
            error: 'Batch check failed.', 
            details: e.message 
        });
    }
};