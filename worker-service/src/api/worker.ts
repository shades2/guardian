import { Logger, MessageBrokerChannel, SettingsContainer } from '@guardian/common';
import {
    ExternalMessageEvents,
    ITask,
    ITaskResult,
    IWorkerRequest,
    WorkerEvents,
    WorkerTaskType
} from '@guardian/interfaces';
import { HederaSDKHelper } from './helpers/hedera-sdk-helper';
import { Environment } from './helpers/environment';
import { IpfsClient } from './ipfs-client';
import Blob from 'cross-blob';
import { AccountId, PrivateKey, TokenId } from '@hashgraph/sdk';
import { HederaUtils } from './helpers/utils';

/**
 * Sleep helper
 * @param t
 */
function rejectTimeout(t: number): Promise<void> {
    return new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error('Timeout error'));
        }, t);
    })
}

/**
 * Worker class
 */
export class Worker {
    /**
     * Logger instance
     * @private
     */
    private readonly logger: Logger;

    /**
     * Ipfs client
     */
    private ipfsClient: IpfsClient;

    /**
     * Current task ID
     */
    private currentTaskId: string;

    /**
     * Update event received flag
     * @private
     */
    private updateEventReceived = false;

    /**
     * Worker in use
     * @private
     */
    private _isInUse: boolean = false;

    /**
     * Worker in use getter
     * @private
     */
    private get isInUse(): boolean {
        return this._isInUse;
    }

    /**
     * Worker in use setter
     * @private
     */
    private set isInUse(v: boolean) {
        this._isInUse = v;
    }

    /**
     * Minimum priority
     * @private
     */
    private readonly minPriority: number;

    /**
     * Maximum priority
     * @private
     */
    private readonly maxPriority: number;

    /**
     * Task timeout
     * @private
     */
    private readonly taskTimeout: number;

    /**
     * Channel Name
     * @private
     */
    private readonly _channelName: string;

    constructor(
        private readonly channel: MessageBrokerChannel
    ) {
        const { IPFS_STORAGE_API_KEY } = new SettingsContainer().settings;

        this.logger = new Logger();
        this.ipfsClient = new IpfsClient(IPFS_STORAGE_API_KEY);

        this.minPriority = parseInt(process.env.MIN_PRIORITY, 10);
        this.maxPriority = parseInt(process.env.MAX_PRIORITY, 10);
        this.taskTimeout = parseInt(process.env.TASK_TIMEOUT, 10) * 1000; // env in seconds
        this._channelName = process.env.SERVICE_CHANNEL.toUpperCase();
    }

    /**
     * Initialize worker
     */
    public init(): void {
        setInterval(() => {
            if (!this.isInUse) {
                this.getItem().then();
            }
        }, parseInt(process.env.REFRESH_INTERVAL, 10) * 1000);

        this.channel.subscribe(WorkerEvents.QUEUE_UPDATED, () => {
            if (!this.isInUse) {
                this.getItem().then();
            } else {
                this.updateEventReceived = true;
            }
        });

        this.channel.subscribe(WorkerEvents.UPDATE_SETTINGS, (msg: any) => {
            new SettingsContainer().updateSetting('IPFS_STORAGE_API_KEY', msg.ipfsStorageApiKey);
            this.ipfsClient = new IpfsClient(msg.ipfsStorageApiKey);
        });

        HederaSDKHelper.setTransactionResponseCallback(async (client: any) => {
            try {
                const balance = await HederaSDKHelper.balance(client, client.operatorAccountId);
                await this.channel.request(['api-gateway', 'update-user-balance'].join('.'), {
                    balance,
                    unit: 'Hbar',
                    operatorAccountId: client.operatorAccountId.toString()
                });
            } catch (error) {
                throw new Error(`Worker (${['api-gateway', 'update-user-balance'].join('.')}) send: ` + error);
            }
        })
    }

    /**
     * Request to guardian service method
     * @param entity
     * @param params
     * @param type
     */
    private async request<T extends any>(entity: string, params?: IWorkerRequest | ITaskResult, type?: string): Promise<T> {
        try {
            const response = await this.channel.request<any, T>(`guardians.${entity}`, params);
            if (!response) {
                throw new Error('Server is not available');
            }
            if (response.error) {
                throw new Error(response.error);
            }
            return response.body;
        } catch (error) {
            throw new Error(`Guardian (${entity}) send: ` + error);
        }
    }

    /**
     * Clear states
     * @private
     */
    private clearState(): void {
        this.isInUse = false;
        this.currentTaskId = null;
        this.updateEventReceived = false;
    }

    /**
     * Task actions
     * @param task
     * @private
     */
    private async processTask(task: ITask): Promise<ITaskResult> {
        const result: ITaskResult = {
            id: this.currentTaskId
        }

        try {
            switch (task.type) {
                case WorkerTaskType.ADD_FILE: {
                    let fileContent = Buffer.from(task.data.payload.content, 'base64');
                    const data = await this.channel.request<any, any>(ExternalMessageEvents.IPFS_BEFORE_UPLOAD_CONTENT, task.data.payload);
                    if (data && data.body) {
                        fileContent = Buffer.from(data.body, 'base64')
                    }
                    const blob: any = new Blob([fileContent]);
                    const r = await this.ipfsClient.addFile(blob);
                    this.channel.publish(ExternalMessageEvents.IPFS_ADDED_FILE, r);
                    result.data = r;
                    break;
                }

                case WorkerTaskType.GET_FILE: {
                    if (!task.data.payload || !task.data.payload.cid || !task.data.payload.responseType) {
                        result.error = 'Invalid CID';
                    } else {
                        let fileContent = await this.ipfsClient.getFile(task.data.payload.cid);
                        if (fileContent instanceof Buffer) {
                            const data = await this.channel.request<any, any>(ExternalMessageEvents.IPFS_AFTER_READ_CONTENT, {
                                responseType: !task.data.payload.responseType,
                                content: fileContent.toString('base64'),
                            });
                            if (data && data.body) {
                                fileContent = Buffer.from(data.body, 'base64')
                            }
                        }

                        switch (task.data.payload.responseType) {
                            case 'str':
                                result.data = Buffer.from(fileContent, 'binary').toString();
                                break;

                            case 'json':
                                result.data = Buffer.from(fileContent, 'binary').toJSON();
                                break;

                            default:
                                result.data = fileContent
                        }
                    }
                    break;
                }

                case WorkerTaskType.SEND_HEDERA: {
                    Environment.setNetwork(task.data.network);
                    Environment.setLocalNodeAddress(task.data.localNodeAddress);
                    Environment.setLocalNodeProtocol(task.data.localNodeProtocol);
                    const { operatorId, operatorKey, dryRun } = task.data.clientOptions;
                    const client = new HederaSDKHelper(operatorId, operatorKey, dryRun);
                    const { topicId, buffer, submitKey, memo } = task.data;
                    result.data = await client.submitMessage(topicId, buffer, submitKey, memo);
                    break;
                }

                case WorkerTaskType.GENERATE_DEMO_KEY: {
                    const { operatorId, operatorKey, initialBalance } = task.data;
                    const client = new HederaSDKHelper(operatorId, operatorKey);
                    const treasury = await client.newAccount(initialBalance);
                    result.data = {
                        id: treasury.id.toString(),
                        key: treasury.key.toString()
                    };
                    break;
                }

                case WorkerTaskType.GET_USER_BALANCE: {
                    const { hederaAccountId, hederaAccountKey } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey);
                    result.data = await client.balance(hederaAccountId);

                    break;
                }

                case WorkerTaskType.GET_ACCOUNT_INFO: {
                    const { userID, userKey, hederaAccountId } = task.data;
                    const client = new HederaSDKHelper(userID, userKey);
                    result.data = await client.accountInfo(hederaAccountId);

                    break;
                }

                case WorkerTaskType.CREATE_TOKEN: {
                    const {
                        operatorId,
                        operatorKey,
                        decimals,
                        enableAdmin,
                        enableFreeze,
                        enableKYC,
                        enableWipe,
                        initialSupply,
                        tokenName,
                        tokenSymbol,
                        tokenType
                    } = task.data;
                    const client = new HederaSDKHelper(operatorId, operatorKey);
                    const nft = tokenType === 'non-fungible';
                    const _decimals = nft ? 0 : decimals;
                    const _initialSupply = nft ? 0 : initialSupply;
                    const treasuryId = AccountId.fromString(operatorId);
                    const treasuryKey = HederaUtils.parsPrivateKey(operatorKey);
                    const supplyKey = PrivateKey.generate();
                    const adminKey = enableAdmin ? PrivateKey.generate() : null;
                    const freezeKey = enableFreeze ? PrivateKey.generate() : null;
                    const kycKey = enableKYC ? PrivateKey.generate() : null;
                    const wipeKey = enableWipe ? PrivateKey.generate() : null;
                    const tokenMemo = '';
                    const tokenId = await client.newToken(
                        tokenName,
                        tokenSymbol,
                        nft,
                        _decimals,
                        _initialSupply,
                        tokenMemo,
                        treasuryId,
                        treasuryKey,
                        supplyKey,
                        adminKey,
                        kycKey,
                        freezeKey,
                        wipeKey
                    );
                    result.data = {
                        tokenId,
                        tokenName,
                        tokenSymbol,
                        tokenType,
                        decimals: _decimals,
                        initialSupply: _initialSupply,
                        treasuryId: treasuryId.toString(),
                        treasuryKey: treasuryKey.toString(),
                        supplyKey: supplyKey.toString(),
                        adminKey: adminKey ? adminKey.toString() : null,
                        freezeKey: freezeKey ? freezeKey.toString() : null,
                        kycKey: kycKey ? kycKey.toString() : null,
                        wipeKey: wipeKey ? wipeKey.toString() : null
                    }
                    break;
                }

                case WorkerTaskType.UPDATE_TOKEN: {
                    const {
                        tokenId,
                        operatorId,
                        operatorKey,
                        adminKey,
                        changes
                    } = task.data;

                    if (changes.freezeKey) {
                        changes.freezeKey = PrivateKey.generate();
                    }
                    if (changes.kycKey) {
                        changes.kycKey = PrivateKey.generate();
                    }
                    if (changes.wipeKey) {
                        changes.wipeKey = PrivateKey.generate();
                    }
                    const client = new HederaSDKHelper(operatorId, operatorKey);
                    const status = await client.updateToken(
                        TokenId.fromString(tokenId),
                        HederaUtils.parsPrivateKey(adminKey, true, 'Admin Key'),
                        changes
                    )

                    result.data = {
                        status,
                        freezeKey: changes.freezeKey ? changes.freezeKey.toString() : null,
                        kycKey: changes.kycKey ? changes.kycKey.toString() : null,
                        wipeKey: changes.wipeKey ? changes.wipeKey.toString() : null
                    }

                    break;
                }

                case WorkerTaskType.DELETE_TOKEN: {
                    const {
                        tokenId,
                        operatorId,
                        operatorKey,
                        adminKey,
                    } = task.data;

                    const client = new HederaSDKHelper(operatorId, operatorKey);
                    result.data = await client.deleteToken(
                        TokenId.fromString(tokenId),
                        HederaUtils.parsPrivateKey(adminKey, true, 'Admin Key')
                    )

                    break;
                }

                case WorkerTaskType.ASSOCIATE_TOKEN: {
                    const { userID, userKey, associate, tokenId, dryRun } = task.data;
                    const client = new HederaSDKHelper(userID, userKey, dryRun);
                    if (associate) {
                        result.data = await client.associate(tokenId, userID, userKey);
                    } else {
                        result.data = await client.dissociate(tokenId, userID, userKey);
                    }

                    break;
                }

                case WorkerTaskType.GRANT_KYC_TOKEN: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        userHederaAccountId,
                        tokenId,
                        kycKey,
                        grant,
                        dryRun
                    } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun);

                    if (grant) {
                        result.data = await client.grantKyc(tokenId, userHederaAccountId, kycKey);
                    } else {
                        result.data = await client.revokeKyc(tokenId, userHederaAccountId, kycKey);
                    }

                    break;
                }

                case WorkerTaskType.FREEZE_TOKEN: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        userHederaAccountId,
                        tokenId,
                        freezeKey,
                        freeze,
                        dryRun
                    } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun);
                    if (freeze) {
                        result.data = await client.freeze(tokenId, userHederaAccountId, freezeKey);
                    } else {
                        result.data = await client.unfreeze(tokenId, userHederaAccountId, freezeKey);
                    }

                    break;
                }

                case WorkerTaskType.MINT_NFT: {
                    const { hederaAccountId, hederaAccountKey, dryRun, tokenId, supplyKey, metaData, transactionMemo } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun);
                    let data: Uint8Array[];
                    if (Array.isArray(metaData)) {
                        data = new Array<Uint8Array>(metaData.length);
                        for (let i = 0; i < metaData.length; i++) {
                            data[i] = new Uint8Array(Buffer.from(metaData[i]));
                        }
                    } else {
                        data = [new Uint8Array(Buffer.from(metaData))];
                    }
                    result.data = await client.mintNFT(tokenId, supplyKey, data, transactionMemo);
                    break;
                }

                case WorkerTaskType.TRANSFER_NFT: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        dryRun,
                        tokenId,
                        targetAccount,
                        treasuryId,
                        treasuryKey,
                        element,
                        transactionMemo
                    } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun);
                    result.data = await client.transferNFT(tokenId, targetAccount, treasuryId, treasuryKey, element, transactionMemo);
                    break;
                }

                case WorkerTaskType.MINT_FT: {
                    const { hederaAccountId, hederaAccountKey, dryRun, tokenId, supplyKey, tokenValue, transactionMemo } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun);
                    result.data = await client.mint(tokenId, supplyKey, tokenValue, transactionMemo);
                    break;
                }

                case WorkerTaskType.TRANSFER_FT: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        dryRun,
                        tokenId,
                        targetAccount,
                        treasuryId,
                        treasuryKey,
                        tokenValue,
                        transactionMemo
                    } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun);
                    result.data = await client.transfer(tokenId, targetAccount, treasuryId, treasuryKey, tokenValue, transactionMemo);
                    break;
                }

                case WorkerTaskType.WIPE_TOKEN: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        targetAccount,
                        tokenValue,
                        dryRun,
                        token,
                        wipeKey,
                        uuid
                    } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun);
                    if (token.tokenType === 'non-fungible') {
                        result.error = 'unsupported operation';
                    } else {
                        await client.wipe(token.tokenId, targetAccount, wipeKey, tokenValue, uuid);
                        result.data = {}
                    }
                    break;
                }

                case WorkerTaskType.NEW_TOPIC: {
                    const { hederaAccountId, hederaAccountKey, dryRun, topicMemo, keys } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun);
                    let adminKey: any = null;
                    let submitKey: any = null;
                    if (keys) {
                        if (keys.admin) {
                            adminKey = hederaAccountKey;
                        }
                        if (keys.submit) {
                            submitKey = hederaAccountKey;
                        }
                    } else {
                        adminKey = hederaAccountKey;
                        submitKey = hederaAccountKey;
                    }
                    result.data = await client.newTopic(
                        adminKey,
                        submitKey,
                        topicMemo
                    );

                    break;
                }

                case WorkerTaskType.GET_TOPIC_MESSAGE: {
                    const {
                        operatorId,
                        operatorKey,
                        dryRun,
                        timeStamp
                    } = task.data;
                    const client = new HederaSDKHelper(operatorId, operatorKey, dryRun);
                    result.data = await client.getTopicMessage(timeStamp);

                    break;
                }

                case WorkerTaskType.GET_TOPIC_MESSAGES: {
                    const {
                        operatorId,
                        operatorKey,
                        dryRun,
                        topic
                    } = task.data;
                    const client = new HederaSDKHelper(operatorId, operatorKey, dryRun);
                    result.data = await client.getTopicMessages(topic);

                    break;
                }

                case WorkerTaskType.CHECK_ACCOUNT: {
                    const { hederaAccountId } = task.data;
                    result.data = !HederaSDKHelper.checkAccount(hederaAccountId);

                    break;
                }

                default:
                    result.error = 'unknown task'
            }
            ///////
        } catch (e) {
            result.error = e.message;
        }

        return result;
    }

    /**
     * Process with timeout
     * @param task
     * @private
     */
    private processTaskWithTimeout(task: ITask): Promise<ITaskResult> {
        return new Promise(async (resolve, reject) => {
            try {
                const result = await Promise.race([
                    this.processTask(task),
                    rejectTimeout(this.taskTimeout)
                ]);
                resolve(result as ITaskResult);
            } catch (e) {
                const error = {
                    id: this.currentTaskId,
                    error: 'Unknown error'
                }
                if (e) {
                    error.error = e.message || e;
                }
                resolve(error);
            }
        })
    }

    /**
     * Get item from queue
     */
    public async getItem(): Promise<any> {
        this.isInUse = true;

        this.logger.info(`Search task`, [this._channelName]);

        let task: any = null;
        try {
            task = await Promise.race([
                this.request(WorkerEvents.QUEUE_GET, {
                    minPriority: this.minPriority,
                    maxPriority: this.maxPriority,
                    taskTimeout: this.taskTimeout
                }),
                rejectTimeout(this.taskTimeout)
            ]);
        } catch (e) {
            this.clearState();
            return;
        }

        if (!task) {
            this.isInUse = false;

            this.logger.info(`Task not found`, [this._channelName]);

            if (this.updateEventReceived) {
                this.updateEventReceived = false;
                this.getItem().then();
            }

            return;
        }

        this.currentTaskId = task.id;

        this.logger.info(`Task started: ${task.id}, ${task.type}`, [this._channelName]);

        const result = await this.processTaskWithTimeout(task);

        try {
            await this.request(WorkerEvents.TASK_COMPLETE, result);
            if (result?.error) {
                this.logger.error(`Task error: ${this.currentTaskId}, ${result?.error}`, [this._channelName]);
            } else {
                this.logger.info(`Task completed: ${this.currentTaskId}`, [this._channelName]);
            }
        } catch (error) {
            this.logger.error(error.message, [this._channelName]);
            this.clearState();

        }

        this.getItem().then();
    }
}
