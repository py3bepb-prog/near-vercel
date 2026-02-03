// api/burn_scheduler.js (MAINNET VERSION)
const nearAPI = require('near-api-js');
const { send } = require('micro');
const { createClient } = require('@supabase/supabase-js');
const Big = require('big.js');

// --- MAINNET CONFIGURATION ---
const NETWORK_ID = 'mainnet';
const NODE_URL = 'https://rpc.mainnet.near.org';

const TOKEN_CONTRACT_ID = process.env.TOKEN_CONTRACT_ID;
const SENDER_ID = process.env.NEAR_SENDER_ID;
const PRIVATE_KEY = process.env.NEAR_PRIVATE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

const ONE_YOCTO = BigInt(1);
const GAS_LIMIT = BigInt('30000000000000'); // 30 TGas
const TOKEN_DECIMALS = 18; 

const nearConfig = {
    networkId: NETWORK_ID,
    nodeUrl: NODE_URL,
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    }
});

/**
 * FIXED MATH: Converts float amount to atomic yocto-string (18 decimals)
 */
function toYoctoString(amount) {
    if (amount === undefined || amount === null) {
        throw new Error("Amount cannot be null or undefined.");
    }
    const amountBig = new Big(amount);
    // 1.5 -> "1.500000000000000000" -> "1500000000000000000"
    return amountBig.toFixed(TOKEN_DECIMALS).replace('.', '');
}

module.exports = async (req, res) => {
    let batchId = null;
    let totalBurnAmount = 0; 
    
    if (!PRIVATE_KEY || !SENDER_ID || !TOKEN_CONTRACT_ID || !SUPABASE_SERVICE_ROLE_KEY) {
        return send(res, 500, { error: 'Server configuration error: Required secrets missing.' });
    }

    try {
        // --- STEP 1: COLLECT PENDING BURNS FROM DB ---
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

        const amountYoctoString = toYoctoString(totalBurnAmount);

        // --- STEP 2: NEAR MAINNET TRANSACTION (ft_burn) ---
        const { KeyPair, keyStores, transactions } = nearAPI;
        const keyPair = KeyPair.fromString(PRIVATE_KEY);
        const keyStore = new keyStores.InMemoryKeyStore();
        await keyStore.setKey(NETWORK_ID, SENDER_ID, keyPair);
        
        const near = await nearAPI.connect({ ...nearConfig, keyStore });
        const account = await near.account(SENDER_ID);
        
        const burnAction = transactions.functionCall(
            'ft_burn',
            { 
                amount: amountYoctoString, 
                memo: `Batch Burn ID: ${batchId}` 
            },
            GAS_LIMIT,
            ONE_YOCTO 
        );

        const nearTransactionResult = await account.signAndSendTransaction({
            receiverId: TOKEN_CONTRACT_ID, 
            actions: [burnAction],
        });

        const transactionHash = nearTransactionResult.transaction.hash; 

        // --- STEP 3: COMPLETE IN DB ---
        const { error: completeError } = await supabase.rpc('burn_batch_complete', {
            p_batch_id: batchId,
            p_near_hash: transactionHash,
            p_status: 'completed',
        });

        if (completeError) {
            console.error('Database completion error (CRITICAL):', completeError.message);
            return send(res, 200, { 
                message: 'Batch Burn successful, but DB update failed. Manual check required.', 
                hash: transactionHash,
                batch_ids: transactionIds
            });
        }
        
        return send(res, 200, {
            message: `Batch Burn completed. Amount: ${totalBurnAmount}.`,
            hash: transactionHash,
            batch_ids: transactionIds
        });

    } catch (e) {
        console.error('NEAR Burn Error:', e.message);

        // --- STEP 4: ROLLBACK IN DB ---
        if (batchId) {
            const { error: rollbackError } = await supabase.rpc('burn_batch_complete', {
                p_batch_id: batchId,
                p_near_hash: null,
                p_status: 'failed', 
            });

            if (rollbackError) {
                console.error('CRITICAL ROLLBACK ERROR:', rollbackError.message);
                return send(res, 500, { 
                    error: `Critical: Burn failed and DB rollback failed for batch ${batchId}.`,
                });
            }
        }
        
        return send(res, 500, { error: `Batch Burn failed. Status set to 'failed'. Details: ${e.message}` });
    }
};