import sdk, { ScryptedInterface, Setting, Settings, EventListenerRegister, ObjectDetector, MotionSensor, ScryptedDevice, ObjectsDetected, Camera, MediaObject, ObjectDetectionResult, ScryptedDeviceBase, ScryptedDeviceType } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { DetectionRuleActivation, EventType, filterAndSortValidDetections, getDetectionRuleKeys, getMixinBaseSettings, getWebookUrls, isDeviceEnabled } from "./utils";
import { defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap } from "./detecionClasses";
import HomeAssistantUtilitiesProvider from "./main";

const { systemManager } = sdk;

const snapshotWidth = 1280;
const snapshotHeight = 720;

export class AdvancedNotifierCameraMixin extends SettingsMixinDeviceBase<any> implements Settings {
    storageSettings = new StorageSettings(this, {
        ...getMixinBaseSettings(this.name, this.type),
        minDelayTime: {
            subgroup: 'Notifier',
            title: 'Minimum notification delay',
            description: 'Minimum amount of sedonds to wait until a notification is sent for the same detection type',
            type: 'number',
            defaultValue: 15,
        },
        ignoreCameraDetections: {
            title: 'Ignore camera detections',
            description: 'If checked, only the detections coming from NVR will be used',
            type: 'boolean',
            subgroup: 'Detection',
        },
        whitelistedZones: {
            title: 'Whitelisted zones',
            description: 'Zones that will trigger a notification',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Detection',
            choices: [],
            defaultValue: [],
        },
        blacklistedZones: {
            title: 'Blacklisted zones',
            description: 'Zones that will not trigger a notification',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Detection',
            choices: [],
            defaultValue: [],
        },
        detectionClasses: {
            title: 'Detection classes',
            multiple: true,
            combobox: true,
            subgroup: 'Detection',
            choices: [],
            defaultValue: [DetectionClass.Person, DetectionClass.Face]
        },
        scoreThreshold: {
            title: 'Default score threshold',
            subgroup: 'Detection',
            type: 'number',
            defaultValue: 0.7,
            placeholder: '0.7',
        },
        alwaysZones: {
            title: 'Always enabled zones',
            description: 'Zones that will trigger a notification, regardless of the device is active or not in the main selector',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Notifier',
            choices: [],
            defaultValue: [],
        },
        // WEBHOOKS
        lastSnapshotWebhook: {
            subgroup: 'Webhooks',
            title: 'Last snapshot webhook',
            type: 'boolean',
            immediate: true,
        },
        lastSnapshotWebhookCloudUrl: {
            subgroup: 'Webhooks',
            type: 'string',
            title: 'Cloud URL',
            readonly: true,
            // TODO: export on common fn
            onGet: async () => {
                const isWebhookEnabled = this.storageSettings.getItem('lastSnapshotWebhook');
                return {
                    hide: !isWebhookEnabled,
                }
            }
        },
        lastSnapshotWebhookLocalUrl: {
            subgroup: 'Webhooks',
            type: 'string',
            title: 'Local URL',
            readonly: true,
            onGet: async () => {
                const isWebhookEnabled = this.storageSettings.getItem('lastSnapshotWebhook');
                return {
                    hide: !isWebhookEnabled,
                }
            }
        },
        lastSnapshotImageUrl: {
            subgroup: 'Webhooks',
            type: 'string',
            title: 'Last image URL',
            readonly: true,
            onGet: async () => {
                const isWebhookEnabled = this.storageSettings.getItem('lastSnapshotWebhook');
                return {
                    hide: !isWebhookEnabled,
                }
            }
        },
        detectionRules: {
            title: 'Rules',
            group: 'Advanced notifier detection rules',
            type: 'string',
            multiple: true,
            combobox: true,
            defaultValue: [],
            choices: [],
        }
    });

    detectionListener: EventListenerRegister;
    motionListener: EventListenerRegister;
    motionTimeout: NodeJS.Timeout;
    mainLoopListener: NodeJS.Timeout;
    isActiveForNotifications: boolean;
    isActiveForMqttReporting: boolean;
    motionInProgress: boolean;
    mqttReportInProgress: boolean;
    lastDetectionMap: Record<string, number> = {};
    // disabledNotifiers: string[] = [];
    logger: Console;
    mqttAutodiscoverySent: boolean;
    killed: boolean;
    nvrEnabled: boolean = true;
    nvrMixinId: string;
    observeZones: string[];

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);

        this.storageSettings.settings.room.onGet = async () => {
            const rooms = this.plugin.storageSettings.getItem('fetchedRooms');
            // const rooms = (await mainPluginDevice.getSettings()).find(setting => setting.key === 'fetchedRooms')?.value as string[];
            return {
                choices: rooms ?? []
            }
        }
        this.storageSettings.settings.entityId.onGet = async () => {
            const entities = this.plugin.storageSettings.getItem('fetchedEntities');
            // const entities = (await mainPluginDevice.getSettings()).find(setting => setting.key === 'fetchedEntities')?.value as string[];
            return {
                choices: entities ?? []
            }
        }

        this.nvrMixinId = systemManager.getDeviceByName('Scrypted NVR Object Detection')?.id;

        this.storageSettings.settings.whitelistedZones.onGet = async () => ({ choices: this.observeZones });
        this.storageSettings.settings.blacklistedZones.onGet = async () => ({ choices: this.observeZones });
        this.storageSettings.settings.alwaysZones.onGet = async () => ({ choices: this.observeZones });
        this.storageSettings.settings.detectionClasses.onGet = async () => {
            // const settings = await this.mixinDevice.getSettings();
            // const detectionClasses = settings.find((setting: { key: string; }) => new RegExp('objectdetectionplugin:.*:allowList').test(setting.key))?.value ?? [];
            // const deviceObjectTypes = this.mixinDevice.getObjectTypes ? (await this.mixinDevice.getObjectTypes())?.classes || [] : [];
            // const choices = uniq([...deviceObjectTypes, ...detectionClasses, ...defaultDetectionClasses])

            return {
                choices: defaultDetectionClasses,
            }
        };

        this.initValues().then().catch(this.console.log);
        this.startCheckInterval().then().catch(this.console.log);

        this.plugin.currentMixinsMap[this.name] = this;
    }

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            // const useNvrDetections = this.storageSettings.values.useNvrDetections;
            const useNvrDetections = false;
            const { isActiveForMqttReporting, isActiveForNotifications, isPluginEnabled } = await isDeviceEnabled(this.name);

            const triggerAlwaysNotification = this.storageSettings.values.triggerAlwaysNotification;
            const alwaysActiveByAlwaysZones = !!this.storageSettings.values.alwaysZones?.length;

            const newIsCameraActiveForNotifications = !useNvrDetections && (isActiveForNotifications || triggerAlwaysNotification || alwaysActiveByAlwaysZones);
            const newIsCameraActiveForMqttReporting = !useNvrDetections && isActiveForMqttReporting;

            if (!isPluginEnabled && (newIsCameraActiveForNotifications || newIsCameraActiveForMqttReporting)) {
                logger.log('Plugin is not enabled.');
            }

            this.isActiveForNotifications = isPluginEnabled && newIsCameraActiveForNotifications;
            this.isActiveForMqttReporting = isPluginEnabled && newIsCameraActiveForMqttReporting;

            const isCurrentlyRunning = !!this.detectionListener;
            const shouldRun = this.isActiveForMqttReporting || this.isActiveForNotifications;

            if (newIsCameraActiveForMqttReporting && !this.mqttAutodiscoverySent) {
                const mqttClient = await this.plugin.getMqttClient();
                if (mqttClient) {
                    const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase & Settings;
                    await mqttClient.setupDeviceAutodiscovery({
                        device,
                        console: logger,
                        withDetections: true,
                        deviceClass: 'motion'
                    });

                    this.mqttAutodiscoverySent = true;
                }
            }

            if (isCurrentlyRunning && !shouldRun) {
                logger.log('Stopping and cleaning listeners.');
                this.resetListeners();
            } else if (!isCurrentlyRunning && shouldRun) {
                logger.log(`Starting  ${ScryptedInterface.ObjectDetector} listeners: ${JSON.stringify({
                    notificationsActive: newIsCameraActiveForNotifications,
                    mqttReportsActive: newIsCameraActiveForMqttReporting,
                    notificationsAlwaysActive: alwaysActiveByAlwaysZones,
                    useNvrDetections,
                    isPluginEnabled,
                })}`);
                await this.startListeners();
            }
        };

        this.mainLoopListener = setInterval(async () => {
            try {
                if (this.killed) {
                    await this.release();
                } else {
                    await funct();
                }
            } catch (e) {
                logger.log('Error in startCheckInterval', e);
            }
        }, 5000);
    }

    resetTimeouts() {
        this.motionTimeout && clearTimeout(this.motionTimeout);
        this.motionTimeout = undefined;
        this.motionListener?.removeListener && this.motionListener.removeListener();
        this.motionListener = undefined;
    }

    resetListeners() {
        if (this.detectionListener) {
            this.getLogger().log('Resetting listeners.');
        }

        this.resetTimeouts();
        this.detectionListener?.removeListener && this.detectionListener.removeListener();
        this.detectionListener = undefined;
    }

    async initValues() {
        const { lastSnapshotCloudUrl, lastSnapshotLocalUrl } = await getWebookUrls(this.name, console);
        this.storageSettings.putSetting('lastSnapshotWebhookCloudUrl', lastSnapshotCloudUrl);
        this.storageSettings.putSetting('lastSnapshotWebhookLocalUrl', lastSnapshotLocalUrl);

        const settings = await this.mixinDevice.getSettings();
        const zonesSetting = settings.find((setting: { key: string; }) => new RegExp('objectdetectionplugin:.*:zones').test(setting.key))?.value ?? [];

        const filteredZones = zonesSetting.filter(zone => {
            const zoneFilterMode = settings.find((setting: { key: string; }) => new RegExp(`objectdetectionplugin:.*:zoneinfo-filterMode-${zone}`).test(setting.key))?.value;

            return zoneFilterMode === 'observe';

        });
        this.observeZones = filteredZones;
    }

    async getMixinSettings(): Promise<Setting[]> {
        const canUseNvr = this.nvrMixinId && this.mixins.includes(this.nvrMixinId);

        this.nvrEnabled = canUseNvr;
        this.storageSettings.settings.whitelistedZones.hide = !canUseNvr;
        this.storageSettings.settings.blacklistedZones.hide = !canUseNvr;
        this.storageSettings.settings.alwaysZones.hide = !canUseNvr;
        this.storageSettings.settings.ignoreCameraDetections.hide = !canUseNvr;

        const settings: Setting[] = await this.storageSettings.getSettings();

        if (this.interfaces.includes(ScryptedInterface.VideoCamera)) {
            const detectionClasses = this.storageSettings.getItem('detectionClasses') ?? [];
            for (const detectionClass of detectionClasses) {
                const key = `${detectionClass}:scoreThreshold`;
                settings.push({
                    key,
                    title: `Score threshold for ${detectionClass}`,
                    subgroup: 'Detection',
                    type: 'number',
                    value: this.storageSettings.getItem(key as any)
                });
            }
        }

        const currentDetectionRules = this.storageSettings.getItem('detectionRules');
        const detectionRulesGroup = 'Advanced notifier detection rules';

        for (const detectionRuleName of currentDetectionRules) {
            const {
                enabledKey,
                activationKey,
                detecionClassesKey,
                notifiersKey,
                scoreThresholdKey,
                zonesKey
            } = getDetectionRuleKeys(detectionRuleName);

            settings.push(
                {
                    key: enabledKey,
                    title: 'Enabled',
                    type: 'boolean',
                    group: detectionRulesGroup,
                    subgroup: detectionRuleName,
                    value: this.storageSettings.getItem(enabledKey) as boolean ?? true
                },
                {
                    key: activationKey,
                    title: 'Activation',
                    group: detectionRulesGroup,
                    subgroup: detectionRuleName,
                    combobox: true,
                    choices: [DetectionRuleActivation.Always, DetectionRuleActivation.OnActive],
                    value: this.storageSettings.getItem(activationKey) as string
                },
                {
                    key: detecionClassesKey,
                    title: 'Detection classes',
                    group: detectionRulesGroup,
                    subgroup: detectionRuleName,
                    multiple: true,
                    combobox: true,
                    choices: defaultDetectionClasses,
                    value: JSON.parse(this.storageSettings.getItem(detecionClassesKey) as string ?? '[]')
                },
                {
                    key: scoreThresholdKey,
                    title: 'Score threshold',
                    group: detectionRulesGroup,
                    subgroup: detectionRuleName,
                    type: 'number',
                    placeholder: '0.7',
                    value: this.storageSettings.getItem(scoreThresholdKey) as string
                },
                {
                    key: zonesKey,
                    title: 'Zones',
                    group: detectionRulesGroup,
                    subgroup: detectionRuleName,
                    multiple: true,
                    combobox: true,
                    choices: this.observeZones,
                    value: JSON.parse(this.storageSettings.getItem(zonesKey) as string ?? '[]')
                },
                {
                    key: notifiersKey,
                    title: 'Notifiers',
                    group: detectionRulesGroup,
                    subgroup: detectionRuleName,
                    type: 'device',
                    multiple: true,
                    combobox: true,
                    deviceFilter: `(type === '${ScryptedDeviceType.Notifier}')`,
                    value: JSON.parse(this.storageSettings.getItem(notifiersKey) as string ?? '[]')
                }
            )
        };


        return settings;
    }

    async putMixinSetting(key: string, value: string) {
        this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }

    async release() {
        this.killed = true;
        this.resetListeners();
        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = undefined;
    }

    private getLogger() {
        const deviceConsole = sdk.deviceManager.getMixinConsole(this.id, this.nativeId);

        if (!this.logger) {
            const log = (debug: boolean, message?: any, ...optionalParams: any[]) => {
                const now = new Date().toLocaleString();
                if (!debug || this.storageSettings.getItem('debug')) {
                    deviceConsole.log(` ${now} - `, message, ...optionalParams);
                }
            };
            this.logger = {
                log: (message?: any, ...optionalParams: any[]) => log(false, message, ...optionalParams),
                debug: (message?: any, ...optionalParams: any[]) => log(true, message, ...optionalParams),
            } as Console
        }

        return this.logger;
    }

    async reportDetectionsToMqtt(detections: ObjectDetectionResult[], triggerTime: number, logger: Console) {
        if (!this.mqttReportInProgress) {
            this.mqttReportInProgress = true;
            const mqttClient = await this.plugin.getMqttClient();

            if (mqttClient) {
                try {
                    const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase;
                    await mqttClient.publishRelevantDetections({
                        console: logger,
                        detections,
                        device,
                        triggerTime,
                    }).finally(() => this.mqttReportInProgress = false);
                } catch (e) {
                    logger.log(`Error in reportDetectionsToMqtt`, e);
                }
            }
        }
    }

    async triggerMotion(props: { detection?: ObjectDetectionResult, image?: MediaObject }) {
        const { detection, image } = props;
        const logger = this.getLogger();

        const b64Image = image ? (await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg'))?.toString('base64') : undefined;

        const report = async (triggered: boolean) => {
            this.resetTimeouts();
            if (this.isActiveForMqttReporting) {
                const mqttClient = await this.plugin.getMqttClient();

                if (mqttClient) {
                    try {
                        const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase;
                        await mqttClient.publishDeviceState({
                            device,
                            triggered,
                            console: logger,
                            b64Image,
                            detection,
                            resettAllClasses: !triggered,
                            ignoreMainEntity: !detection
                        }).finally(() => this.mqttReportInProgress = false);
                    } catch (e) {
                        logger.log(`Error in reportDetectionsToMqtt`, e);
                    }
                }
            }
            this.motionInProgress = triggered;
        }

        await report(true);

        const minDelayTime = this.storageSettings.values.minDelayTime;

        this.motionListener = systemManager.listenDevice(this.id, {
            event: ScryptedInterface.MotionSensor,
            watch: true,
        }, async (_, __, data) => {
            if (!data) {
                if (detection) {
                    logger.log(`Motion end triggered by the device.`);
                }
                await report(false);
            }
        });

        this.motionTimeout = setTimeout(async () => {
            if (detection) {
                logger.log(`Motion end triggered automatically after ${minDelayTime}s.`);
            }
            await report(false);
        }, minDelayTime * 1000);
    }

    getObjectDetector() {
        // return this.mixinDevice as (ObjectDetector & MotionSensor & ScryptedDevice & Camera);
        return systemManager.getDeviceById(this.id) as (ObjectDetector & MotionSensor & ScryptedDevice & Camera);
    }

    getLastDetectionkey(detection: ObjectDetectionResult) {
        const { className, label } = detection;
        let key = className;
        if (label) {
            key += `-${label}`;
        }

        return key;
    }

    public async processDetections(props: { detections: ObjectDetectionResult[], triggerTime: number }) {
        const { detections, triggerTime } = props;
        const logger = this.getLogger();

        if (!detections?.length) {
            return;
        }

        const objectDetector = this.getObjectDetector();

        if (!objectDetector) {
            logger.log(`Device ${this.name}-${this.id} not found`);
            return;
        }

        const {
            alwaysZones,
            blacklistedZones,
            whitelistedZones,
            detectionClasses,
            scoreThreshold,
            minDelayTime,
            ignoreCameraDetections,
            disabledNotifiers,
        } = this.storageSettings.values;

        const candidates = filterAndSortValidDetections(detections ?? [], logger);

        // const mqttImage = detection.detectionId ? await objectDetector.getDetectionInput(detection.detectionId, details.eventId) : undefined;

        // const mqttImage = await objectDetector.takePicture({
        //     reason: 'event',
        //     picture: {
        //         height: snapshotHeight,
        //         width: snapshotWidth,
        //     },
        // });
        if (this.isActiveForMqttReporting) {
            // let image;
            // if (uniqueSortedDetections.length > 1) {
            //     image = await objectDetector.takePicture({
            //         reason: 'periodic',
            //         picture: {
            //             height: snapshotHeight,
            //             width: snapshotWidth,
            //         },
            //     });
            // }
            this.reportDetectionsToMqtt(candidates, triggerTime, logger);
        }

        let dataToReport = {};
        try {
            const now = new Date().getTime();
            logger.debug(`Detections incoming ${JSON.stringify(candidates)}`);
            const match = candidates.find(d => {
                if (ignoreCameraDetections && !d.boundingBox) {
                    return false;
                }

                const { className: classnameRaw, score, label, zones } = d;
                const className = detectionClassesDefaultMap[classnameRaw] ?? classnameRaw;

                if (detectionClasses?.length && !detectionClasses.includes(className)) {
                    logger.debug(`Classname ${className} not contained in ${detectionClasses}`);
                    return false;
                }
                const lastDetectionkey = this.getLastDetectionkey(d);
                const lastDetection = this.lastDetectionMap[lastDetectionkey];
                if (lastDetection && (now - lastDetection) < 1000 * minDelayTime) {
                    logger.debug(`Waiting for delay: ${(now - lastDetection) / 1000}s`);
                    return false;
                }

                const scoreToUse = this.storageSettings.getItem(`${className}:scoreThreshold` as any) || scoreThreshold;
                const scoreOk = !score || score > scoreToUse;

                if (!scoreOk) {
                    logger.debug(`Score ${score} not ok ${scoreToUse}`);
                    return false;
                }

                const isAlwaysIncluded = alwaysZones.length ? zones.some(zone => alwaysZones.includes(zone)) : false;
                const isIncluded = whitelistedZones.length ? zones.some(zone => whitelistedZones.includes(zone)) : true;
                const isExcluded = blacklistedZones.length ? zones.some(zone => blacklistedZones.includes(zone)) : false;

                const zonesOk = isAlwaysIncluded || (isIncluded && !isExcluded);

                if (!zonesOk) {
                    logger.debug(`Zones ${zones} not ok`);
                    return false;
                }

                dataToReport = {
                    isAlwaysIncluded,
                    isIncluded,
                    isExcluded,
                    zones,
                    zonesOk,

                    score,
                    scoreToUse,
                    scoreOk,

                    className,
                    detectionClasses
                };

                return true;
            });

            let image;

            if (match) {
                this.lastDetectionMap[this.getLastDetectionkey(match)] = now;

                // let image: MediaObject;
                // const useDetectorImage = useNvrImages && !!detection.detectionId;
                // if (useDetectorImage) {
                //     image = await objectDetector.getDetectionInput(detection.detectionId, details.eventId);
                // } else {
                image = await objectDetector.takePicture({
                    reason: 'event',
                    picture: {
                        height: snapshotHeight,
                        width: snapshotWidth,
                    },
                });
                // }

                logger.log(`Matching detection found: ${JSON.stringify({
                    match,
                    ...dataToReport,
                    // useDetectorImage,
                })}`);


                if (image) {
                    const imageUrl = await sdk.mediaManager.convertMediaObjectToLocalUrl(image, 'image/jpg');
                    logger.debug(`Updating webook last image URL: ${imageUrl}`);
                    this.storageSettings.putSetting('lastSnapshotImageUrl', imageUrl);
                }
            }

            this.triggerMotion({ detection: match, image });

            this.plugin.matchDetectionFound({
                triggerDeviceId: this.id,
                match,
                candidates,
                image,
                logger,
                eventType: EventType.ObjectDetection,
                triggerTime,
                shouldNotify: this.isActiveForNotifications && !!match,
                disabledNotifiers,
            });
        } catch (e) {
            logger.log('Error finding a match', e);
        }
    }

    async startListeners() {
        this.detectionListener = systemManager.listenDevice(this.id, ScryptedInterface.ObjectDetector, async (_, __, data) => {
            const detection: ObjectsDetected = data;

            const { timestamp } = detection;

            this.processDetections({ detections: detection.detections, triggerTime: timestamp })
        });
    }
}