// api/burn_scheduler.js

const nearAPI = require('near-api-js');
const { send } = require('micro');
const { createClient } = require('@supabase/supabase-js');
const Big = require('big.js'); // npm install big.js

// --- КОНСТАНТЫ СЕТИ И SUPABASE ---
const NETWORK_ID = 'testnet';
const NODE_URL = 'https://rpc.testnet.near.org';

// Переменные окружения Vercel
// Убедитесь, что они названы точно так же, как в настройках Vercel
const TOKEN_CONTRACT_ID = process.env.TOKEN_CONTRACT_ID;
const SENDER_ID = process.env.NEAR_SENDER_ID;
const PRIVATE_KEY = process.env.NEAR_PRIVATE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

// --- КОНСТАНТЫ ДЛЯ ТРАНЗАКЦИЙ И ТОКЕНОВ ---
const ONE_YOCTO = BigInt(1);
const GAS_LIMIT = BigInt('30000000000000');
// !!! ВАЖНО: ПРОВЕРЬТЕ ТОЧНОСТЬ ВАШЕГО ТОКЕНА NEAR !!!
const TOKEN_DECIMALS = 18; 
const DECIMAL_BASE = BigInt(10) ** BigInt(TOKEN_DECIMALS); 

const nearConfig = {
    networkId: NETWORK_ID,
    nodeUrl: NODE_URL,
};

// Инициализация Supabase клиента (с Service Role Key)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    }
});

// ====================================================
// ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ: ПРЕОБРАЗОВАНИЕ В ЙОКТО (Вариант 1)
// ====================================================

/**
 * Преобразует дробное число (Float), полученное из БД, в строку йокто-единиц (BigInt string)
 * @param {number|string} amount - Дробная сумма токена.
 * @returns {string} Сумма в йокто-единицах (строка).
 */
function toYoctoString(amount) {
    if (amount === undefined || amount === null) {
        throw new Error("Amount cannot be null or undefined.");
    }
    
    // Используем Big.js для безопасной работы с дробными числами
    const amountBig = new Big(amount);
    
    // amount.toFixed(TOKEN_DECIMALS) гарантирует, что у нас есть нужная точность
    const amountString = amountBig.toFixed(TOKEN_DECIMALS);
    const [integerPart, fractionalPart] = amountString.split('.');

    // Конвертируем целую часть и дробную часть отдельно и суммируем их как BigInt
    const totalYocto = BigInt(integerPart) * DECIMAL_BASE + BigInt(fractionalPart);
    
    return totalYocto.toString();
}


// ====================================================
// ОСНОВНАЯ ФУНКЦИЯ CRON JOB
// ====================================================
module.exports = async (req, res) => {
    let batchId = null;
    let totalBurnAmount = 0; 
    
    if (!PRIVATE_KEY || !SENDER_ID || !TOKEN_CONTRACT_ID || !SUPABASE_SERVICE_ROLE_KEY) {
        return send(res, 500, { error: 'Server configuration error: Required secrets missing.' });
    }

    try {
        // --- ЭТАП 1: СБОР ЗАЯВОК ИЗ БД (public.collect_pending_burns) ---
        const { data: collectData, error: collectError } = await supabase.rpc('collect_pending_burns');

        if (collectError) {
             console.error('DB RPC Error during collect_pending_burns:', collectError.message);
             return send(res, 500, { error: 'Database collection failed.' });
        }
        
        if (collectData.status === 'no_data') {
            return send(res, 200, { message: 'No pending burns to process.', status: 'NO_OP' });
        }
        
        batchId = collectData.batch_id;
        totalBurnAmount = parseFloat(collectData.total_amount);
        const transactionIds = collectData.transaction_ids; 
        
        console.log(`Starting Batch Burn ID ${batchId} for total amount: ${totalBurnAmount}`);

        // 1.1. Преобразование общей суммы в йокто-NEAR
        const amountYoctoString = toYoctoString(totalBurnAmount);

        // --- ЭТАП 2: NEAR-ТРАНЗАКЦИЯ (ft_burn) ---
        
        // 2.1. Инициализация NEAR
        const { KeyPair, keyStores, transactions } = nearAPI;
        const { InMemoryKeyStore } = keyStores;
        
        const keyPair = KeyPair.fromString(PRIVATE_KEY);
        const keyStore = new InMemoryKeyStore();
        await keyStore.setKey(NETWORK_ID, SENDER_ID, keyPair);
        
        const near = await nearAPI.connect({ ...nearConfig, keyStore });
        const account = await near.account(SENDER_ID);
        
        // 2.2. Формирование действия ft_burn
        const burnAction = transactions.functionCall(
            'ft_burn',
            { 
                amount: amountYoctoString, // Сумма в йокто-единицах
                memo: `Batch Burn ID: ${batchId}` 
            },
            GAS_LIMIT,
            ONE_YOCTO 
        );

        // 2.3. Выполнение транзакции
        const nearTransactionResult = await account.signAndSendTransaction({
            receiverId: TOKEN_CONTRACT_ID, 
            actions: [burnAction],
        });

        const transactionHash = nearTransactionResult.transaction.hash; 

        // --- ЭТАП 3: ЗАВЕРШЕНИЕ В БД (public.burn_batch_complete) ---
        
        const { error: completeError } = await supabase.rpc('burn_batch_complete', {
            p_batch_id: batchId,
            p_near_hash: transactionHash,
            p_status: 'completed', // Успех
        });

        if (completeError) {
            console.error('Database completion error (CRITICAL WARNING):', completeError.message);
            return send(res, 200, { 
                message: 'Batch Burn OK, DB completion failed (Manual Check Needed).', 
                hash: transactionHash,
                batch_ids: transactionIds
            });
        }
        
        // 4. Успешный ответ
        return send(res, 200, {
            message: `Batch Burn completed successfully. Amount: ${totalBurnAmount}.`,
            hash: transactionHash,
            batch_ids: transactionIds
        });

    } catch (e) {
        console.error('NEAR transaction or execution error:', e.message);

        // --- ЭТАП 4: ОТКАТ (ROLLBACK) ---
        if (batchId) {
            // Если транзакция NEAR не удалась, помечаем пакет как 'failed'
            const { error: rollbackError } = await supabase.rpc('burn_batch_complete', {
                p_batch_id: batchId,
                p_near_hash: null, // Хеш отсутствует
                p_status: 'failed', 
            });

            if (rollbackError) {
                console.error('CRITICAL ROLLBACK ERROR:', rollbackError.message);
                return send(res, 500, { 
                    error: `CRITICAL ERROR: NEAR failed and DB rollback failed for batch ${batchId}. Status may be stuck at 'processed'.`,
                });
            }
        }
        
        return send(res, 500, { error: `Batch Burn failed. Status marked as 'failed' in DB. Details: ${e.message}` });
    }
};