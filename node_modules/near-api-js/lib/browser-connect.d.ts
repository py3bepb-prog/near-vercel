import { NearConfig, Near } from './near.js';
import '@near-js/accounts';
import '@near-js/crypto';
import '@near-js/keystores';
import '@near-js/signers';
import '@near-js/utils';
import '@near-js/providers';

/** @deprecated Will be removed in the next major release */
interface ConnectConfig extends NearConfig {
    /** @hidden */
    keyPath?: string;
}
/**
 * @deprecated Will be removed in the next major release
 *
 * Initialize connection to Near network.
 */
declare function connect(config: ConnectConfig): Promise<Near>;

export { type ConnectConfig, connect };
