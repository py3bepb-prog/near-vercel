const { createClient } = require('@supabase/supabase-js');
const { send } = require('micro'); 
const json = require('micro').json; 
const axios = require('axios'); 

// --- SECRETS AND CONSTANTS ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Our collector wallet (app.vibeindex.near)
const DEPOSIT_ACCOUNT_ID = process.env.NEAR_SENDER_ID; 

// Token contract (token.vibeindex.near)
const TOKEN_CONTRACT_ID = process.env.TOKEN_CONTRACT_ID; 

// Используем переменную из окружения, если она есть, иначе ставим дефолт Mainnet
const NEARBLOCKS_BASE_URL = process.env.NEARBLOCKS_BASE_URL || 'https://api.nearblocks.io';

// Теперь URL формируется динамически
const EXPLORER_API_URL = `${NEARBLOCKS_BASE_URL}/v1/account/${TOKEN_CONTRACT_ID}/txns`; 

module.exports = async (req, res) => {
    
    if (req.method !== 'POST') {
        return send(res, 405, { error: 'Method Not Allowed' });
    }
    
    try {
        const data = await json(req);
        // lastCheckedTime in nanoseconds (BigInt) from your database
        const lastCheckedTime = BigInt(data.last_checked_time || 0);
        let latestTxnTimestamp = lastCheckedTime; 

        // 1. REQUEST TO NEARBLOCKS MAINNET API
        const explorerResponse = await axios.get(EXPLORER_API_URL, {
            params: {
                limit: 50, 
                order: 'desc' 
            }
        });

        // 2. ITERATION AND FILTERING
        const txns = explorerResponse.data.txns || [];
        let newDeposits = 0;
        
	for (const txn of txns) {
            const currentTxnTimestamp = BigInt(txn.block_timestamp); 
            
            if (currentTxnTimestamp <= lastCheckedTime) {
                break; 
            }
            
            if (currentTxnTimestamp > latestTxnTimestamp) {
                latestTxnTimestamp = currentTxnTimestamp;
            }

            // --- КРИТИЧЕСКОЕ ДОБАВЛЕНИЕ: ПРОВЕРКА СТАТУСА ---
            // В Nearblocks API статус обычно находится в txn.outcomes.status
            // Мы обрабатываем только успешные транзакции.
            const isSuccess = txn.outcomes && txn.outcomes.status === true; 
            // В некоторых версиях API это может быть строка 'success' или поле status: 1
            // Для Nearblocks v1 это обычно булево значение в outcomes.status
            
            if (!isSuccess) continue; 

            const ftTransferAction = txn.actions.find(
                a => a.action === 'FUNCTION_CALL' && a.method === 'ft_transfer'
            );

            if (ftTransferAction) {
                try {
                    const args = JSON.parse(ftTransferAction.args);
                    
                    // CHECK: Is this an incoming deposit to our app wallet?
                    if (args.receiver_id === DEPOSIT_ACCOUNT_ID) {
                        
                        const depositData = {
                            tx_hash: txn.transaction_hash,
                            sender_id: txn.predecessor_account_id, 
                            amount: args.amount, // Full atomic amount (with 18 decimals)
                            created_at: new Date(Number(currentTxnTimestamp) / 1000000).toISOString(),
                        };

                        // 3. UPSERT TO SUPABASE
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