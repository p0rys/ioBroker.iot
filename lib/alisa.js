'use strict';
const {Types, ChannelDetector} = require('iobroker.type-detector');
const uuid = require('uuid/v1');

// Description
// ??

const ignoreIds = [
    /^system\./,
    /^script\./,
];

function replaceInvalidChars(name) {
    name = name.replace(/[^a-zA-Z0-9А-Яа-я_]/g, '_');
    name = name.replace(/Ü/g, 'UE');
    name = name.replace(/Ä/g, 'AE');
    name = name.replace(/Ö/g, 'OE');
    name = name.replace(/ü/g, 'ue');
    name = name.replace(/ä/g, 'ae');
    name = name.replace(/ö/g, 'oe');
    name = name.replace(/ß/g, 'ss');
    return name;
} 

const typesMapping = {
    on_off: 'OnOff',
    color_setting: 'RGB',
    range: 'Brightness'
};

class YandexAliceConverter {
    constructor(adapter) {
        this.adapter = adapter;
        this.lang = 'ru';

        this.types = {
            [Types.socket]: this._processSocket.bind(this),
            [Types.light]: this._processLight.bind(this),
            [Types.dimmer]: this._processDimmer.bind(this),
            [Types.ct]: this._processCT.bind(this),
            [Types.rgbSingle]: this._processRGB.bind(this),
        };
        this._entities = [];
        this._entity2ID = {};
        this._ID2entity = {};
    }

    setLanguage(lang) {
        this.lang = lang || 'ru';
    }

    _getSmartName(obj) {
        if (!this.adapter.config.noCommon) {
            return obj && obj.common ? obj.common.smartName || '' : '';
        } else {
            return (obj &&
                obj.common &&
                obj.common.custom &&
                obj.common.custom[this.adapter.namespace] || '') ?
                obj.common.custom[this.adapter.namespace].smartName : '';
        }
    }

    _getObjectName(obj, _lang) {
        _lang = _lang || this.lang;

        let result = this._getSmartName(obj);

        if (!result) {
            result = obj && obj.common ? obj.common.name : null;
            result = result || obj._id;
        }

        if (typeof result === 'object') {
            if (result[_lang] || result.en) {
                return result[_lang] || result.en;
            } else {
                // take first not empty value
                const lang = Object.keys(result).find(lang => result[lang]);
                if (result[lang]) {
                    return result[lang];
                } else {
                    return obj._id;
                }
            }
        }

        return result || '';
    }

    _generateName(obj, lang) {
        return this._getObjectName(obj, lang).replace(/[^-._\w0-9А-Яа-яÄÜÖßäöü]/g, '_');
    }
    
    _processCommon(id, name, room, func, obj, entityType, entity_id) {
        if (!name) {
            if (func && room) {
                name = room + ' ' + func;
            } else {
                name = obj.common.custom[this.adapter.namespace].name || this._generateName(obj);
            }
        }
        const _name = replaceInvalidChars(this._generateName(obj, 'en'));

        const entity = {
            entity_id: entity_id || (entityType + '.' + _name),
            //state: this._iobState2EntityState(obj._id, state.val);
            attributes: {
                friendly_name: name
            },

            // объект описания smart-устройства
            context: {
                id: obj._id,
                type: entityType,
                name: name,
                description: name,
                room: room,
                custom_data: {
                    entity_id: entity_id || (entityType + '.' + _name),
                },
                capabilities: [],
                device_info: {
                    manufacturer: 'IOBroker',
                    model: entity_id || (entityType + '.' + _name),
                    hw_version: '',
                    sw_version: this.adapter.version
                }
            },

            // доступные команды для управления
            COMMANDS: {},
            ATTRIBUTES: [],
        };

        if (obj.common.unit) {
            entity.attributes.unit_of_measurement = obj.common.unit;
            //entity.attributes.unit_of_measurement_dict = obj.common.unit;
        }

        this._ID2entity[obj._id] = this._ID2entity[obj._id] || [];
        this._ID2entity[obj._id].push(entity);
        this._entity2ID[entity.entity_id] = entity;
        this._entities.push(entity);
        return entity;
    }

    _addID2entity(id, entity) {
        this._ID2entity[id] = this._ID2entity[id] || [];
        const found = this._ID2entity[id].find(e => e.entity_id === entity.entity_id);
        if (!found) {
            this._ID2entity[id].push(entity);
        }
    }

    // ------------------------------- START OF CONVERTERS ---------------------------------------- //

    _processSocket(id, control, name, room, func, _obj) {
        const entity = this._processCommon(id, name, room, func, _obj, 'devices.types.switch');

        let state = control.states.find(s => s.id && s.name === 'SET');
        entity.STATE = {setId: null, getId: null};
        if (state && state.id) {
            entity.STATE.setId = state.id;
            entity.STATE.getId = state.id;
            entity.attributes.icon = 'mdi:power-socket-eu';
            this._addID2entity(state.id, entity);
        }

        state = control.states.find(s => s.id && s.name === 'ACTUAL');
        if (state && state.id) {
            entity.STATE.getId = state.id;
            this._addID2entity(state.id, entity);
        }

        // capabilities
        entity.context.capabilities.push({
            type: 'devices.capabilities.on_off',
        });
        entity.COMMANDS.get_state = this._getStateOnOff.bind(this);
        entity.COMMANDS.set_state = this._setStateOnOff.bind(this);
        return entity;
    }

    _getStateOnOff(entity) {
        return new Promise(resolve => {
            const stateId = entity.STATE.getId;
            const capability = entity.context.capabilities.find(cap => cap.type === 'devices.capabilities.on_off');
            if (capability && stateId) {
                this.adapter.getForeignState(stateId, (err, state) => {
                    if (!err && state) {
                        capability.state = {
                            instance: 'on',
                            value: state.val,
                        };
                    }
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    _setStateOnOff(entity, data) {
        return new Promise(resolve => {
            const stateId = entity.STATE.setId;
            const capability = data.capabilities.find(cap => cap.type === 'devices.capabilities.on_off');
            if (capability && capability.state && stateId) {
                this.adapter.setForeignState(stateId, capability.state.value);
                capability.state.action_result = {status: 'DONE'};
            }
            resolve(data);
        });
    }

    _getStateBrightness(entity) {
        return new Promise(resolve => {
            const dimmer = entity.ATTRIBUTES.find(attr => attr.attribute === 'brightness');
            const stateId = dimmer ? dimmer.getId : undefined;
            const capability = entity.context.capabilities.find(cap => cap.type === 'devices.capabilities.range');
            if (capability && stateId) {
                this.adapter.getForeignState(stateId, (err, state) => {
                    if (!err && state) {
                        capability.state = {
                            instance: 'brightness',
                            value: state.val,
                        };
                    }
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    _setStateBrightness(entity, data) {
        return new Promise(resolve => {
            const dimmer = entity.ATTRIBUTES.find(attr => attr.attribute === 'brightness');
            const stateId = dimmer ? dimmer.getId : undefined;
            const capability = data.capabilities.find(cap => cap.type === 'devices.capabilities.range');
            if (capability && capability.state && stateId) {
                this.adapter.setForeignState(stateId, capability.state.value);
                capability.state.action_result = {status: 'DONE'};
            }
            resolve(data);
        });
    }

    _getStateCT(entity) {
        return new Promise(resolve => {
            const ct = entity.ATTRIBUTES.find(attr => attr.attribute === 'ct');
            const stateId = ct ? ct.getId : undefined;
            const capability = entity.context.capabilities.find(cap => cap.type === 'devices.capabilities.color_setting');
            if (capability && stateId) {
                this.adapter.getForeignState(stateId, (err, state) => {
                    if (!err && state) {
                        let val = parseInt(state.val);
                        // if (val) {
                        //     val = 1000000/val;
                        // }
                        capability.state = {
                            instance: 'temperature_k',
                            value: val,
                        };
                    }
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    _setStateCT(entity, data) {
        return new Promise(resolve => {
            const ct = entity.ATTRIBUTES.find(attr => attr.attribute === 'ct');
            const stateId = ct ? ct.getId : undefined;
            const capability = data.capabilities.find(cap => cap.type === 'devices.capabilities.color_setting');
            if (capability && capability.state && stateId && capability.state.instance == 'temperature_k') {
                let val = parseInt(capability.state.value);
                // if (val) {
                //     val = Math.round(val/1000000);
                // }
                this.adapter.setForeignState(stateId, val);
                capability.state.action_result = {status: 'DONE'};
            }
            resolve(data);
        });
    }

    _getStateRGB(entity) {
        return new Promise(resolve => {
            const rgb = entity.ATTRIBUTES.find(attr => attr.attribute === 'rgb');
            const stateId = rgb ? rgb.getId : undefined;
            const capability = entity.context.capabilities.find(cap => cap.type === 'devices.capabilities.color_setting');
            if (capability && stateId) {
                this.adapter.getForeignState(stateId, (err, state) => {
                    if (!err && state) {
                        const val = state.val.replace('#', '');
                        capability.state = {
                            instance: 'rgb',
                            value: parseInt(val, 16),
                        };
                    }
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    _setStateRGB(entity, data) {
        return new Promise(resolve => {
            const rgb = entity.ATTRIBUTES.find(attr => attr.attribute === 'rgb');
            const stateId = rgb ? rgb.getId : undefined;
            const capability = data.capabilities.find(cap => cap.type === 'devices.capabilities.color_setting');
            if (capability && capability.state && stateId && capability.state.instance == 'rgb') {
                const val = capability.state.value.toString(16);
                this.adapter.setForeignState(stateId, `#${val}`);
                capability.state.action_result = {status: 'DONE'};
            }
            resolve(data);
        });
    }

    _processLight(id, control, name, room, func, _obj) {
        const entity = this._processCommon(id, name, room, func, _obj, 'devices.types.light');

        let state = control.states.find(s => s.id && ['ON_SET', 'ON', 'SET'].includes(s.name));
        entity.STATE = {setId: null, getId: null};
        if (state && state.id) {
            entity.STATE.setId = state.id;
            entity.STATE.getId = state.id;
            this._addID2entity(state.id, entity);
        }

        state = control.states.find(s => s.id && s.name === 'ACTUAL');
        if (state && state.id) {
            entity.STATE.getId = state.id;
            this._addID2entity(state.id, entity);
        }

        // capabilities
        entity.context.capabilities.push({
            type: 'devices.capabilities.on_off',
        });
        entity.COMMANDS.get_state = this._getStateOnOff.bind(this);
        entity.COMMANDS.set_state = this._setStateOnOff.bind(this);
        return entity;
    }
    
    _processDimmer(id, control, name, room, func, _obj) {
        const entity = this._processCommon(id, name, room, func, _obj, 'devices.types.light');

        let state = control.states.find(s => s.id && ['ON_SET', 'ON'].includes(s.name));
        entity.STATE = {setId: null, getId: null};
        if (state && state.id) {
            entity.STATE.setId = state.id;
            entity.STATE.getId = state.id;
            this._addID2entity(state.id, entity);
        }

        state = control.states.find(s => s.id && s.name === 'ON_ACTUAL');
        if (state && state.id) {
            entity.STATE.getId = state.id;
            this._addID2entity(state.id, entity);
        }

        let getDimmer;
        state = control.states.find(s => s.id && s.name === 'ACTUAL');
        if (state && state.id) {
            getDimmer = state.id;
        }

        state = control.states.find(s => s.id && ['DIMMER', 'SET', 'BRIGHTNESS'].includes(s.name));
        if (state && state.id) {
            getDimmer = getDimmer || state.id;
            entity.ATTRIBUTES.push({attribute: 'brightness', getId: getDimmer, setId: getDimmer});
            this._addID2entity(state.id, entity);
        } else if (getDimmer) {
            entity.ATTRIBUTES.push({attribute: 'brightness', getId: getDimmer, setId: getDimmer});
            this._addID2entity(state.id, entity);
        }

        // capabilities
        if (entity.STATE.getId) {
            entity.context.capabilities.push({
                type: 'devices.capabilities.on_off',
            });
        }

        if (getDimmer) {
            entity.context.capabilities.push({
                type: 'devices.capabilities.range',
                retrievable: true,
                parameters: {
                    instance: 'brightness',
                    unit: 'unit.percent',
                    range: {min: 0, max: 100, precision: 1},
                },
            });
        }

        entity.COMMANDS.get_state = (entity) =>
            this._getStateOnOff(entity).then(() =>
                this._getStateBrightness(entity));

        entity.COMMANDS.set_state = (entity, data) =>
            this._setStateOnOff(entity, data).then((res) =>
                this._setStateBrightness(entity, res));

        return entity;
    }

    _processCT(id, control, name, room, func, _obj) {
        const entity = this._processDimmer(id, control, name, room, func, _obj);
        // const ctState = control.states.find(s => s.id && ['TEMPERATURE'].includes(s.name));
        // if (ctState && ctState.id) {
        //     entity.ATTRIBUTES.push({attribute: 'ct', getId: ctState.id, setId: ctState.id});
        //     this._addID2entity(ctState.id, entity);
        
        //     // capabilities
        //     entity.context.capabilities.push({
        //         type: 'devices.capabilities.color_setting',
        //         parameters: {
        //             temperature_k: {min: 100, max: 600, precision: 100},
        //         },
        //     });
        
        //     const get_state = entity.COMMANDS.get_state;
        //     const set_state = entity.COMMANDS.set_state;
        
        //     entity.COMMANDS.get_state = (entity) => {
        //         return get_state(entity).then(() =>
        //             this._getStateCT(entity)
        //         )
        //     };
        //     entity.COMMANDS.set_state = (entity, data) => {
        //         return set_state(entity, data).then((data) =>
        //             this._setStateCT(entity, data)
        //         )
        //     };
        // }
        return entity;
    }

    _processRGB(id, control, name, room, func, _obj) {
        const entity = this._processDimmer(id, control, name, room, func, _obj);
        
        const rgbState = control.states.find(s => s.id && ['RGB'].includes(s.name));
        if (rgbState && rgbState.id) {
            entity.ATTRIBUTES.push({attribute: 'rgb', getId: rgbState.id, setId: rgbState.id});
            this._addID2entity(rgbState.id, entity);

            // capabilities
            const capability = entity.context.capabilities.find(cap => cap.type === 'devices.capabilities.color_setting');
            if (!capability) {
                entity.context.capabilities.push({
                    type: 'devices.capabilities.color_setting',
                    parameters: {
                        color_model: 'rgb',
                    },
                });
            } else {
                capability.parameters.color_model = 'rgb';
            }
        
            const get_state = entity.COMMANDS.get_state;
            const set_state = entity.COMMANDS.set_state;
        
            entity.COMMANDS.get_state = (entity) => {
                return get_state(entity).then(() =>
                    this._getStateRGB(entity)
                )
            };
            entity.COMMANDS.set_state = (entity, data) => {
                return set_state(entity, data).then((data) =>
                    this._setStateRGB(entity, data)
                )
            };
        }

        return entity;
    }
}

class YandexAlisa {
    constructor(adapter) {
        this.adapter = adapter;
        this.lang    = 'ru';
        // this.agentUserId = adapter.config.login.replace(/[^-_:a-zA-Z1-9]/g, '_');

        this.smartDevices = [];
        this.enums   = [];
        this.usedIds = [];
        this.detector = new ChannelDetector();
        // this.unknownDevices = {};

        this.converter = new YandexAliceConverter(adapter);
    }

    _subscribeAllIds(ids, cb) {
        if (!ids || !ids.length) {
            cb && cb();
        } else {
            const id = ids.shift();
            console.log('Subscribe ' + id);
            this.adapter.subscribeForeignStates(id, () => setImmediate(() => this._subscribeAllIds(ids, cb)));
        }
    }

    _unsubscribeAllIds(ids, cb) {
        if (!ids || !ids.length) {
            cb && cb();
        } else {
            const id = ids.shift();
            console.log('Subscribe ' + id);
            this.adapter.unsubscribeForeignStates(id, () => setImmediate(() => this._unsubscribeAllIds(ids, cb)));
        }
    }

    unsubscribeAllIds(cb) {
        const ids = [];
        for (const devId in this.smartDevices) {
            if (this.smartDevices.hasOwnProperty(devId)) {
                const custom = this.smartDevices[devId].customData;
                for (const attr in custom) {
                    if (custom.hasOwnProperty(attr) && attr.startsWith('get_') && ids.indexOf(custom[attr]) === -1) {
                        ids.push(custom[attr]);
                    }
                }
            }
        }
        this.adapter.log.debug(`[ALISA] Unsubscribe ${ids.length} states for Alisa`);
        this._unsubscribeAllIds(ids, () => {
            this.adapter.log.debug(`[ALISA] Unsubscribe done`);
            cb && cb();
        });
    }

    subscribeAllIds(cb) {
        const ids = [];
        for (const devId in this.smartDevices) {
            if (this.smartDevices.hasOwnProperty(devId)) {
                const custom = this.smartDevices[devId].customData;
                for (const attr in custom) {
                    if (custom.hasOwnProperty(attr) && attr.startsWith('get_') && ids.indexOf(custom[attr]) === -1) {
                        ids.push(custom[attr]);
                    }
                }
            }
        }
        this.adapter.log.debug(`[ALISA] Subscribe ${ids.length} states for Alisa`);
        this._subscribeAllIds(ids, () => {
            this.adapter.log.debug(`[ALISA] Subscribe done`);
            cb && cb();
        });
    }

    getObjectName(obj) {
        let name = '';
        // extract from smartName the name
        if (this.adapter.config.noCommon) {
            if (obj.common &&
                obj.common.custom &&
                obj.common.custom[this.adapter.namespace] &&
                obj.common.custom[this.adapter.namespace].smartName &&
                obj.common.custom[this.adapter.namespace].smartName !== 'ignore') {
                name = obj.common.custom[this.adapter.namespace].smartName;
            }
        } else {
            if (obj.common &&
                obj.common.smartName &&
                obj.common.smartName !== 'ignore') {
                name = obj.common.smartName;
            }
        }

        // if no smart name found, get the normal key
        if (!name && obj && obj.common && obj.common.name) {
            name = obj.common.name;
        }

        if (name && typeof name === 'object') {
            name = name[this.lang] || name['en'];
        }

        if (!name && obj) {
            name = obj._id.split('.').pop();
        }

        return name;
    }

    checkName(name, obj, room, func) {
        if (!name) {
            name = name || this.getObjectName(obj);
            name = name.replace(/[^a-zA-ZöäüßÖÄÜа-яА-Я0-9]/g, ' ');
            const _name = name.toLowerCase();
            let pos;
            if (room) {
                pos = _name.indexOf(room.toLowerCase());
                if (pos !== -1) {
                    name = name.substring(0, pos) + name.substring(pos + room.length + 1);
                }
            }
            if (func){
                pos = _name.indexOf(func.toLowerCase());
                if (pos !== -1) {
                    name = name.substring(0, pos) + name.substring(pos + room.length + 1);
                }
            }
            name = name.replace(/\s\s/g).replace(/\s\s/g).trim();
        }
        return name;
    }

    setLanguage(_lang) {
        this.lang = _lang || 'ru';
        this.converter.setLanguage(this.lang);
    }

    getSmartName(states, id) {
        if (!id) {
            if (!this.adapter.config.noCommon) {
                return states.common.smartName;
            } else {
                return (states &&
                    states.common &&
                    states.common.custom &&
                    states.common.custom[this.adapter.namespace]) ?
                    states.common.custom[this.adapter.namespace].smartName : undefined;
            }
        } else
        if (!this.adapter.config.noCommon) {
            return states[id] && states[id].common ? states[id].common.smartName : null;
        } else {
            return (states[id] &&
                states[id].common &&
                states[id].common.custom &&
                states[id].common.custom[this.adapter.namespace]) ?
                states[id].common.custom[this.adapter.namespace].smartName : null;
        }
    }

    processState(ids, objects, id, roomName, funcName, result) {
        if (!id) {
            return;
        }

        let friendlyName = this.getSmartName(objects, id);
        if (typeof friendlyName === 'object' && friendlyName) {
            friendlyName = friendlyName[this.lang] || friendlyName.en;
        }

        if (friendlyName === 'ignore' || friendlyName === false) {
            return;
        }

        if (!friendlyName && !roomName && !funcName) {
            return;
        }

        try {
            // try to detect device
            const options = {
                objects:            objects,
                id:                 id,
                _keysOptional:      ids,
                _usedIdsOptional:   this.usedIds
            };
            const controls = this.detector.detect(options);
            if (controls) {
                controls.forEach(control => {
                    if (this.converter.types[control.type]) {
                        const entity = this.converter.types[control.type](id, control, friendlyName, roomName, funcName, objects[id]);                    
                        if (!entity) return;

                        const _entity = result.find(e => e.entity_id === entity.entity_id);
                        if (_entity) {
                            console.log('Duplicates found for ' + entity.entity_id);
                            return;
                        }

                        result.push(entity);
                        this.adapter.log.debug('[ALISA] Created Yandex Alice device: ' + entity.entity_id + ' - ' + control.type + ' - ' + id);
                    }
                });
            } else {
                console.log(`[ALISA] Nothing found for ${options.id}`);
            }
        } catch (e) {
            this.adapter.log.error('[ALISA] Cannot process "' + id + '": ' + e);
        }
    }

    _readObjects() {
        return new Promise(resolve => {
            this.adapter.objects.getObjectView('system', 'state', {}, (err, _states) => {
                this.adapter.objects.getObjectView('system', 'channel', {}, (err, _channels) => {
                    this.adapter.objects.getObjectView('system', 'device', {}, (err, _devices) => {
                        this.adapter.objects.getObjectView('system', 'enum', {}, (err, _enums) => {
                            const objects = {};
                            const enums = {};
                            if (_devices && _devices.rows) {
                                for (let i = 0; i < _devices.rows.length; i++) {
                                    if (_devices.rows[i].value && _devices.rows[i].value._id && !ignoreIds.find(reg => reg.test(_devices.rows[i].value._id))) {
                                        objects[_devices.rows[i].value._id] = _devices.rows[i].value;
                                    }
                                }
                            }
                            if (_channels && _channels.rows) {
                                for (let i = 0; i < _channels.rows.length; i++) {
                                    if (_channels.rows[i].value && _channels.rows[i].value._id && !ignoreIds.find(reg => reg.test(_channels.rows[i].value._id))) {
                                        objects[_channels.rows[i].value._id] = _channels.rows[i].value;
                                    }
                                }
                            }
                            if (_states && _states.rows) {
                                for (let i = 0; i < _states.rows.length; i++) {
                                    if (_states.rows[i].value && _states.rows[i].value._id && !ignoreIds.find(reg => reg.test(_states.rows[i].value._id))) {
                                        objects[_states.rows[i].value._id] = _states.rows[i].value;
                                    }
                                }
                            }
                            if (_enums && _enums.rows) {
                                for (let i = 0; i < _enums.rows.length; i++) {
                                    if (_enums.rows[i].value && _enums.rows[i].value._id) {
                                        enums[_enums.rows[i].value._id] = _enums.rows[i].value;
                                        objects[_enums.rows[i].value._id] = _enums.rows[i].value;
                                    }
                                }
                            }
                            resolve({objects, enums});
                        });
                    });
                });
            });
        });
    }

    updateDevices(cb) {
        this.unsubscribeAllIds(() => {
            this._updateDevices()
                .then(smartDevices => {
                    this.smartDevices = smartDevices;
                    this.adapter.log.debug(`[ALISA] SmartDevices: ${JSON.stringify(smartDevices)}`);
                    // Check KEY
                    this.subscribeAllIds(cb);
                });
        });
    }

    getDevices() {
        const result = this.smartDevices.map(device => {
            return {
                name: device.attributes.friendly_name,
                main: {getId: device.STATE.getId, setId: device.STATE.setId},
                attributes: device.ATTRIBUTES ? device.ATTRIBUTES.map(a => {
                    return {name: a.attribute, getId: a.getId, setId: a.setId}
                }) : [],
                actions: device.context.capabilities.map(cap => {
                    const capText = cap.type.replace('devices.capabilities.', '');
                    return typesMapping[capText] || capText
                }),
                iobID: device.context.id,
                description: device.context.description,
                room: device.context.room,
                func: device.context.type.replace('devices.types.', '').toUpperCase(),
            }
        });
        this.adapter.log.debug(`[ALISA] Devices: ${JSON.stringify(result)}`);
        return result;
    }

    getAll() {
        return this._updateDevices().then(smartDevices => {
            this.smartDevices = smartDevices;
            this.adapter.log.debug(`[ALISA] SmartDevices: ${JSON.stringify(smartDevices)}`);
        });
    }
    
    _getSmartDeviceData(entity) {
        return new Promise(resolve => {
            if (entity.context) {
                if (entity.COMMANDS && entity.COMMANDS.get_state) {
                    entity.COMMANDS.get_state(entity).then(() => resolve(entity.context));
                } else {
                    resolve(entity.context);
                }
            } else {
                resolve();
            }
        });
    }

    _getSmartDeviceState(context) {
    	if (context.capabilities) {
	        return {
	            id: context.id,
	            capabilities: context.capabilities.map(c => {
	                if (c.state) {
	                    return {type: c.type, state: c.state};
	                }
	            }).filter(c => c)
	        }
	    } else {
	    	return context;
	    }
    }

    getSmartDevices() {
        return this.getAll().then(() => {
            const result = [];
            this.smartDevices.forEach(entity => {
                result.push(
                    this._getSmartDeviceData(entity)
                );
            });
            return Promise.all(result);
        });
    }

    querySmartDevicesByIds(ids) {
        return new Promise(resolve => {
            const result = [];
            const exists = [];
            this.smartDevices.filter(
            	entity => ids.includes(entity.context.id)
            ).forEach(entity => {
            	exists.push(entity.context.id);
                result.push(
                    this._getSmartDeviceData(entity)
                );
            });
            ids.forEach(id => {
            	if (!exists.includes(id)) {
            		result.push({
                		id: id,
        				error_code: 'DEVICE_NOT_FOUND',
        				error_message: 'Device not found'
                	});
            	}
            });
            resolve(Promise.all(result));
        });
    }

    _updateDevices() {
        return this._readObjects()
            .then(data => {
                const {objects, enums} = data;
                let ids      = Object.keys(objects);

                this.enums   = [];
                this.smartDevices = {};
                this.enums   = [];
                this.usedIds = [];
                this.keys    = [];

                ids.sort();

                // Build overlap from rooms and functions
                let rooms = [];
                let funcs = [];
                let smartName;
                Object.keys(enums).forEach(id => {
                    smartName = this.getSmartName(enums[id]);
                    if (id.match(/^enum\.rooms\./)     && smartName !== 'ignore' && smartName !== false) {
                        rooms.push(id);
                    } else
                    if (id.match(/^enum\.functions\./) && smartName !== 'ignore' && smartName !== false) {
                        funcs.push(id);
                    }
                });

                let result = [];
                let roomNames = {};
                funcs.forEach(funcId => {
                    const func = enums[funcId];
                    if (!func.common || !func.common.members || typeof func.common.members !== 'object' || !func.common.members.length) return;

                    // Get the name of function (with language and if name is empty)
                    let funcName = this.getSmartName(func);
                    funcName = funcName || func.common.name;
                    if (funcName && typeof funcName === 'object') funcName = funcName[this.lang] || funcName.en;
                    if (!funcName) {
                        funcName = funcId.substring('enum.functions.'.length);
                        funcName = funcName[0].toUpperCase() + funcName.substring(1);
                    }

                    func.common.members.forEach(id => {
                        rooms.forEach(roomId => {
                            const room = enums[roomId];
                            if (!room.common || !room.common.members || typeof func.common.members !== 'object' || !room.common.members.length) return;

                            // If state or channel is in some room and in some function
                            const pos = room.common.members.indexOf(id);
                            if (pos !== -1) {
                                // find name for room if not found earlier
                                if (!roomNames[roomId]) {
                                    // Get the name of function (with language and if name is empty)
                                    let roomName = this.getSmartName(room);
                                    roomName = roomName || room.common.name;
                                    if (roomName && typeof roomName === 'object') roomName = roomName[this.lang] || roomName.en;
                                    if (!roomName) {
                                        roomName = roomId.substring('enum.rooms.'.length);
                                        roomName = roomName[0].toUpperCase() + roomName.substring(1);
                                    }
                                    roomNames[roomId] = roomName;
                                }

                                this.processState(ids, objects, id, roomNames[roomId], funcName, result);
                            }
                        });
                    });
                });

                this.usedIds = null;
                this.keys    = null;

                result.forEach(entity => this.adapter.log.debug(`[ALISA] ${entity.context.id} => ${entity.context.type} ${entity.context.name}`));
                return result;
            });
    }

    _doSmartDeviceAction(entity, data) {
        return new Promise(resolve => {
            if (entity.COMMANDS && entity.COMMANDS.set_state) {
                entity.COMMANDS.set_state(entity, data).then((res) => resolve(res));
            } else {
                resolve({
                    id: data.id,
                    action_result: {
                        status: 'ERROR',
                        error_code: 'INVALID_ACTION',
                        error_message: 'Device has not this action'
                    }
                });
            }
        });
    }

    doAction(deviceData) {
        return new Promise(resolve => {
            const entity = this.smartDevices.find(entity => deviceData.id === entity.context.id);
            if (entity) {
                resolve(this._doSmartDeviceAction(entity, deviceData));
            }
            resolve();
        });
    }

    process(request, isEnabled, callback) {
        if (!request) {
            this.adapter.log.error('[ALISA] Invalid request: no request!');
            return;
        }

        if (!isEnabled) {
            if (this.lang === 'en') {
                callback({error: 'The service deactivated', errorCode: 500});
            } else if (this.lang === 'ru') {
                callback({error: 'Сервис отключен', errorCode: 500});
            } else {
                callback({error: 'Der service ist deaktiviert', errorCode: 500});
            }

            return;
        }

        if (!request.alisa) {
            if (this.lang === 'en') {
                callback({error: 'missing inputs', errorCode: 400});
            } else if (this.lang === 'ru') {
                callback({error: 'Неправильные параметры', errorCode: 400});
            } else {
                callback({error: 'Falsche Parameter', errorCode: 400});
            }
            return;
        }

        let result;

        let isWait = false;

        this.adapter.log.debug(`[ALISA] Received ${JSON.stringify(request.alisa)}`);
        // remove first word. It can be changed in the future.
        let url = request.alisa.replace(/^\/[-_\w\d]+\//, '/');
        switch (url) {
            // https://yandex.ru/dev/dialogs/alice/doc/smart-home/reference/check-docpage/
            case '/v1.0':
                result = {};
                break;

            // https://yandex.ru/dev/dialogs/alice/doc/smart-home/reference/get-devices-docpage/
            case '/v1.0/user/devices':
                this.getSmartDevices().then(devices => {
                    const devicesResult = {
                        request_id: uuid(),
                        payload: {
                            user_id: '1',
                            devices: devices
                        }
                    };
                    result = devicesResult;
                    this.adapter.log.debug(`[ALISA] Response: ${JSON.stringify(result)}`);
                    callback(result);
                    callback = null;
                });
                isWait = true;
                break;

            // https://yandex.ru/dev/dialogs/alice/doc/smart-home/reference/post-devices-query-docpage/
            case '/v1.0/user/devices/query':
                const queryDevices = request.devices || [];
                const ids = [];
                queryDevices.forEach(element => {
                    ids.push(element.id);
                });
                if (ids) {
                    this.querySmartDevicesByIds(ids).then(devices => {
                        const queryResult = {
                            request_id: uuid(),
                            payload: {
                                devices: devices.map(d => this._getSmartDeviceState(d))
                            }
                        };
                        if (!devices.length) {
                            queryResult.payload.devices = queryDevices;
                        }
                        result = queryResult;
                        this.adapter.log.debug(`[ALISA] Response: ${JSON.stringify(result)}`);
                        callback(result);
                        callback = null;
                    });
                }
                isWait = true;
                break;

            // https://yandex.ru/dev/dialogs/alice/doc/smart-home/reference/post-action-docpage/
            case '/v1.0/user/devices/action':
                const actionDevices = request.payload.devices || [];
                const res = [];
                actionDevices.forEach(element => {
                    res.push(this.doAction(element));
                });
                Promise.all(res).then((devices) => {
                    let actionResult = {
                        request_id: uuid(),
                        payload: {
                            devices: devices
                        }
                    };
                    result = actionResult;
                    this.adapter.log.debug(`[ALISA] Response: ${JSON.stringify(result)}`);
                    callback(result);
                    callback = null;
                });
                isWait = true;
                break;

            // https://yandex.ru/dev/dialogs/alice/doc/smart-home/reference/unlink-docpage/
            case '/alisaIot/v1.0/user/unlink':
            	result = {};
            	break;

            default:
                result = {error: 'missing data', errorCode: 400};
                break;
        }

        if (result) {
            this.adapter.log.debug(`[ALISA] Response: ${JSON.stringify(result)}`);
            callback(result);
            callback = null;
            return true;
        }
        if (isWait) {
            return true;
        }

        if (!isWait && callback) {
            if (this.lang === 'en') {
                callback({error: 'missing inputs', errorCode: 400});
            } else if (this.lang === 'ru') {
                callback({error: 'Неправильные параметры', errorCode: 400});
            } else {
                callback({error: 'Falsche Parameter', errorCode: 400});
            }
        }
    }
}

module.exports = YandexAlisa;
