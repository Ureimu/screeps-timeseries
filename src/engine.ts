import { UTF15 } from "./utils/utf15";
import { getDataNodeList, setDataNodeList, TimeSeriesDataStorage, TimeSeriesSegmentStorageData } from "./storage";
import { TimeSeriesEngineOpts, SingleData, SingleTypedTreeData, TimeSeriesEngineData } from "./type";
import { POWERS_OF_2 } from "./utils/utf15/constant";
import { TimeSeriesSegmentManager } from "./TimeSeriesSegmentManager";
import assign from "lodash-es/assign";
import cloneDeep from "lodash-es/cloneDeep";
import isNull from "lodash-es/isNull";
import isUndefined from "lodash-es/isUndefined";
import add from "lodash-es/add";
import isEmpty from "lodash-es/isEmpty";
import isArray from "lodash-es/isArray";

export class TimeSeriesDataEngine<T extends SingleTypedTreeData<SingleData<number>>> {
    private dataGetter: (store: boolean) => T;
    public opts: TimeSeriesEngineOpts;
    /**
     * Creates an instance of TimeSeriesDataEngine.
     * @param {(store: boolean) => T} dataGetter 获取统计数据。每次返回的数据结构应保证不会与之前的结构冲突。参数store代表该次生成的数据是否会被存储。
     * @memberof TimeSeriesDataEngine
     */
    public constructor(dataGetter: (store: boolean) => T, opts?: Partial<TimeSeriesEngineOpts>) {
        this.dataGetter = dataGetter;
        const defaultOpts: TimeSeriesEngineOpts = {
            interval: 15 * 60 * 1000,
            maxSegmentSize: 95 * 1000,
            idList: Array(6)
                .fill(0)
                .map((i, index) => index),
            mutationSize: 10,
            readDataBatchSize: 5,
            ifGatherData: true,
            segmentManager: new TimeSeriesSegmentManager(),
            timeData: () => {
                return {
                    lastRecordTime: 0,
                    interval: this.opts.interval, // 默认间隔15分钟
                    idList: this.opts.idList,
                    activeId: -1,
                    storeStartTick: -1,
                    switchWritingIdTick: -1,
                    getWritingIdTick: -2
                };
            },
            timeGetter() {
                return 0;
            }
        };
        if (opts) {
            this.opts = { ...defaultOpts, ...opts };
        } else {
            this.opts = defaultOpts;
        }
        const timeData = this.opts.timeData();
        if (timeData) {
            timeData.interval = this.opts.interval;
            timeData.idList = this.opts.idList;
        }
    }
    public judgeTime(): boolean {
        const timeNow = Date.now();
        const timeSeries = this.timeData;
        return timeNow - timeSeries.lastRecordTime >= timeSeries.interval;
    }

    private get timeData(): TimeSeriesEngineData {
        return this.opts.timeData();
    }
    private init(seriesData: SingleTypedTreeData<SingleData<string>>, dataInThisTick: T): void {
        assign(seriesData, cloneDeep(dataInThisTick));
        const seriesDataNodeList = getDataNodeList<typeof seriesData, SingleData<string>, string>(seriesData);
        const nodeList = getDataNodeList<T, SingleData<number>, number>(dataInThisTick);
        Object.entries(seriesDataNodeList).forEach(([key, value]) => {
            // console.log(key);
            const { depth } = value;
            const codec = new UTF15({ depth, array: true, meta: true });
            value.data = codec.encode([nodeList[key].data]);
            // console.log([nodeList[key].data], codec.decode(value.data));
        });
    }
    public getDataInThisTick(store: boolean): T {
        const dataInThisTick = this.dataGetter(store);
        dataInThisTick.timeStamp = { data: Date.now(), type: "time", depth: 41 };
        dataInThisTick.gameTime = { data: this.opts.timeGetter(), type: "time", depth: 41 };
        return dataInThisTick;
    }
    private switchActiveIdAndClearNewActiveIdData(): void {
        this.timeData.activeId = this.getNextSegmentId(this.timeData.activeId);
        // console.log(`switched activeId to ${this.timeData.activeId}`);
        console.log(`new data: switched activeId to ${this.timeData.activeId}`);
        // 直接清除数据。
        this.opts.segmentManager.writeSegment(this.timeData.activeId, "");
        this.timeData.switchWritingIdTick = -1;
    }
    private switchActiveIdToGetWritingSegmentId(): void {
        const lastId = this.timeData.activeId;
        this.timeData.activeId = this.getNextSegmentId(this.timeData.activeId);
        if (lastId !== -1 && this.timeData.activeId === this.timeData.idList[0]) {
            // 已经找了一圈，但是依然没有，那就用第一个id开始写。
            this.timeData.getWritingIdTick = -1;
        }
        console.log(`get writing id: switched activeId to ${this.timeData.activeId}`);
        // console.log(`switched activeId to ${this.timeData.activeId}`);
        // 直接清除数据。
        const dataStorage = new TimeSeriesDataStorage(
            this.timeData.idList,
            this.opts.maxSegmentSize,
            this.opts.segmentManager
        );
        const dataStorageFullData = dataStorage.getSeriesData(this.timeData.activeId);
        if (dataStorageFullData?.isWriting) {
            this.timeData.getWritingIdTick = -1;
        }
    }
    private getNextSegmentId(idNow: number): number {
        if (idNow === -1) return this.timeData.idList[0];
        const index = this.timeData.idList.findIndex(value => value === idNow);
        if (index + 1 >= this.timeData.idList.length) {
            return this.timeData.idList[0];
        } else {
            return this.timeData.idList[index + 1];
        }
    }
    /**
     * 传入当前的id和需要的之后的id数量，会返回一个对应数量的id列表（第一位不是idNow），直到循环查找id时遇到idToStop。
     *
     * 当返回的id列表中最后包含idToStop时，说明已到达末尾。
     */
    private getNextSegmentIdList(idNow: number, count: number, idToStop: number): number[] {
        let nextId = idNow;
        const idListInTimeOrder = [];
        do {
            const myNextId = this.getNextSegmentId(nextId);
            idListInTimeOrder.push(myNextId);
            nextId = myNextId;
        } while (nextId !== idToStop && idListInTimeOrder.length < count);
        if (nextId === idToStop && !idListInTimeOrder.includes(nextId) && idListInTimeOrder.length < count) {
            idListInTimeOrder.push(idToStop);
        }
        return idListInTimeOrder;
    }
    private checkStorageSize(
        storage: TimeSeriesDataStorage<SingleTypedTreeData<SingleData<string>>, SingleData<string>>
    ): boolean {
        const dataSize = storage.getSeriesDataSize(this.timeData.activeId);
        if (dataSize > this.opts.maxSegmentSize) {
            this.timeData.switchWritingIdTick = this.opts.timeGetter() + 1;
            this.opts.segmentManager.addId([this.getNextSegmentId(this.timeData.activeId)]);
            return false;
        }
        return true;
    }
    public storeData(): boolean {
        if (!this.opts.ifGatherData) return false;
        let ifStored = false;
        if (this.timeData.getWritingIdTick !== -1) {
            // 获取writingId。
            if (this.timeData.getWritingIdTick !== this.opts.timeGetter()) {
                this.timeData.getWritingIdTick = this.opts.timeGetter() + 1;
                this.opts.segmentManager.addId([this.getNextSegmentId(this.timeData.activeId)]);
            } else {
                this.switchActiveIdToGetWritingSegmentId();
            }
            return false;
        }
        if (this.timeData.switchWritingIdTick === this.opts.timeGetter()) {
            this.switchActiveIdAndClearNewActiveIdData();
            // SegmentManager.writeSegment(this.timeData.activeId, "");
            return false;
        }
        if (this.timeData.storeStartTick === this.opts.timeGetter()) {
            const dataInThisTick = this.getDataInThisTick(true);
            const dataStorage = new TimeSeriesDataStorage(
                this.timeData.idList,
                this.opts.maxSegmentSize,
                this.opts.segmentManager
            );
            const dataStorageFullData = dataStorage.getSeriesData(this.timeData.activeId);
            const seriesData = dataStorageFullData?.series ?? {};
            if (dataStorageFullData && !this.checkStorageSize(dataStorage)) {
                if (dataStorageFullData.isWriting) {
                    dataStorage.setSeriesData(this.timeData.activeId, { ...dataStorageFullData, isWriting: false });
                }
                return false;
            }
            // 同步storeNum
            let storeNum = dataStorageFullData?.storeNum ?? 0;
            // console.log(`seriesData: ${JSON.stringify(seriesData)}`);
            const seriesDataNodeList = getDataNodeList<typeof seriesData, SingleData<string>, string>(seriesData);
            const nodeList = getDataNodeList<T, SingleData<number>, number>(dataInThisTick);
            const mutationSize = this.opts.mutationSize;

            Object.entries(nodeList).forEach(([key, value]) => {
                const nullValue = POWERS_OF_2[value.depth] - 1;
                // 更新exp数据
                if (seriesDataNodeList[key] && value?.exp !== seriesDataNodeList[key]?.exp) {
                    seriesDataNodeList[key].exp = value?.exp;
                }

                if (seriesDataNodeList[key] && value.depth !== seriesDataNodeList[key].depth) {
                    // 深度改变了。需要对本segment内的该条数据做处理保证兼容。
                    const newDepth = value.depth;
                    const oldDepth = seriesDataNodeList[key].depth;
                    const oldCodec = new UTF15({ depth: oldDepth, array: true, meta: true });
                    const oldNumberList = oldCodec.decode(seriesDataNodeList[key].data);
                    const oldNullValue = POWERS_OF_2[oldDepth] - 1;
                    const newCodec = new UTF15({ depth: newDepth, array: true, meta: true });
                    seriesDataNodeList[key].data = newCodec.encode(
                        oldNumberList.map(oldNumber => {
                            if (oldNumber === oldNullValue) {
                                return nullValue;
                            }
                            if (oldNumber > nullValue) {
                                return nullValue - 1;
                            }
                            return oldNumber;
                        })
                    );
                    seriesDataNodeList[key].depth = newDepth;
                }

                // console.log(key);
                let valueToStore = value.data;
                if (isNull(value.data) || isNaN(value.data) || isUndefined(value.data)) {
                    valueToStore = nullValue;
                }
                if (value.data >= nullValue) {
                    valueToStore = nullValue - 1;
                }
                if (value.data < 0) {
                    valueToStore = 0;
                }
                if (seriesDataNodeList[key]) {
                    const { depth, data } = seriesDataNodeList[key];
                    const codec = new UTF15({ depth, array: true, meta: true });
                    const numberList = codec.decode(data);

                    if (
                        seriesDataNodeList[key].mutations?.[seriesDataNodeList[key].mutations.length - 1]?.[0] ===
                            numberList.length - 1 &&
                        numberList[numberList.length - 1] === valueToStore
                    ) {
                        seriesDataNodeList[key].mutations[seriesDataNodeList[key].mutations.length - 1][1]++;
                        return;
                    }
                    if (
                        numberList.length < mutationSize - 1 ||
                        !numberList
                            .slice(numberList.length - mutationSize + 1, numberList.length)
                            .every(listValue => listValue === valueToStore)
                    ) {
                        // if (value.data === undefined || value.data === null) {
                        //     console.log(key);
                        // }
                        numberList.push(valueToStore);
                    } else {
                        const mutations = seriesDataNodeList[key].mutations;
                        const mutationIndex = numberList.length - mutationSize + 1;
                        const actualMutationSize = mutationSize - 1;
                        if (!mutations || mutations.length === 0) {
                            seriesDataNodeList[key].mutations = [[mutationIndex, actualMutationSize]];
                        } else {
                            //console.log(mutations[mutations.length - 1][0], numberList.length - mutationSize);
                            mutations.push([mutationIndex, actualMutationSize]);
                        }
                        // 保留一个不删，以便于后面使用该位重新生成被压缩数据。
                        numberList.splice(mutationIndex + 1, actualMutationSize);
                    }

                    seriesDataNodeList[key].data = codec.encode(numberList);
                } else {
                    const { depth, type, exp } = value;
                    seriesDataNodeList[key] = { depth, data: "", type, exp };
                    const newSeriesDataNode = seriesDataNodeList[key];
                    const codec = new UTF15({ depth, array: true, meta: true });
                    if (storeNum !== 0) {
                        newSeriesDataNode.data = codec.encode([nullValue, valueToStore]);
                        if (!newSeriesDataNode.mutations) {
                            newSeriesDataNode.mutations = [[0, storeNum - 1]];
                        } else {
                            throw new Error(`new created data should not have mutations.`);
                        }
                    } else {
                        newSeriesDataNode.data = codec.encode([valueToStore]);
                    }
                }
            });
            storeNum++;
            Object.entries(seriesDataNodeList).forEach(([key, value]) => {
                // 对seriesDataNodeList做处理，如果本次没有新数据，则推null数据。
                const { depth, data, mutations } = value;
                const codec = new UTF15({ depth, array: true, meta: true });
                const numberList = codec.decode(data);
                const dataSize = numberList.length + (mutations?.map(i => i[1]).reduce(add, 0) ?? 0);
                if (dataSize < storeNum) {
                    const nullCount = storeNum - dataSize;
                    // console.log(
                    //     `${key} value this run:${nodeList?.[key]?.data} has no new data, push null:${nullCount}`
                    // );
                    if (nullCount === 1) {
                        numberList.push(POWERS_OF_2[depth] - 1);
                    } else if (nullCount < mutationSize) {
                        numberList.push(...new Array(nullCount).fill(POWERS_OF_2[depth] - 1));
                    } else {
                        if (
                            mutations &&
                            mutations[mutations.length - 1][0] === numberList.length - 1 &&
                            numberList[numberList.length - 1] === POWERS_OF_2[depth] - 1
                        ) {
                            mutations[mutations.length - 1][1] += nullCount;
                        } else {
                            numberList.push(POWERS_OF_2[depth] - 1);
                            if (mutations) {
                                mutations.push([numberList.length - 1, nullCount - 1]);
                            } else {
                                seriesDataNodeList[key].mutations = [[numberList.length - 1, nullCount - 1]];
                            }
                        }
                    }

                    // const logDataSize =
                    //     numberList.length + (seriesDataNodeList[key].mutations?.map(i => i[1]).reduce(add, 0) ?? 0);
                    // console.log(
                    //     `${key} value this run:${nodeList?.[key]?.data} has no new data, push null:${nullCount}, now store num:${this.timeData.storeNum}, key store num:${logDataSize}`
                    // );

                    seriesDataNodeList[key].data = codec.encode(numberList);
                }
            });
            const convertedSeriesData: TimeSeriesSegmentStorageData<
                SingleTypedTreeData<SingleData<string>>,
                SingleData<string>
            > = {
                series: setDataNodeList<typeof seriesData, SingleData<string>, string>(seriesDataNodeList),
                storeNum: storeNum,
                isWriting: true
            };
            dataStorage.setSeriesData(this.timeData.activeId, convertedSeriesData);

            this.timeData.lastRecordTime = Date.now();
            this.timeData.storeStartTick = -1;
            ifStored = true;
        }
        if (this.judgeTime()) {
            this.timeData.storeStartTick = this.opts.timeGetter() + 1;
            this.opts.segmentManager.addId([this.timeData.activeId]);
        }
        return ifStored;
    }
    public getSegmentIdList(): number[] {
        return this.timeData.idList;
    }
    public dataIdListInTimeOrder(): number[] {
        let nextId = this.timeData.activeId;
        const idListInTimeOrder = [];
        do {
            const myNextId = this.getNextSegmentId(nextId);
            idListInTimeOrder.push(myNextId);
            nextId = myNextId;
        } while (nextId !== this.timeData.activeId);
        return idListInTimeOrder;
    }
    public seriesDataNodeListReadCache: Record<string, SingleData<(number | null)[]>> = {};
    public seriesDataReadNextIdList: number[] = [];
    public storeNumReadCache = 0;
    public seriesDataReadEnd = false;
    /**
     * 获取数据。第一次执行应传入start为true。需要每个tick连续调用，直到返回数据为止。
     */
    public readData(start: boolean): SingleTypedTreeData<SingleData<(number | null)[]>> | false {
        if (this.timeData.getWritingIdTick !== -1) {
            return false;
        }
        const dataStorage = new TimeSeriesDataStorage(
            this.timeData.idList,
            this.opts.maxSegmentSize,
            this.opts.segmentManager
        );
        if (start) {
            this.seriesDataNodeListReadCache = {};
            this.storeNumReadCache = 0;
            this.seriesDataReadNextIdList = this.getNextSegmentIdList(
                this.timeData.activeId,
                this.opts.readDataBatchSize,
                this.timeData.activeId
            );
            this.seriesDataReadEnd = false;
            this.opts.segmentManager.addId(this.seriesDataReadNextIdList);
            // logger.debug(`${this.seriesDataReadNextIdList}`);
            return false;
        }

        if (!this.seriesDataReadEnd) {
            this.seriesDataReadNextIdList.forEach(dataId => {
                const seriesDataHere = dataStorage.getSeriesData(dataId);
                if (seriesDataHere === null || isEmpty(seriesDataHere)) {
                    return;
                }

                const seriesDataNodeList = getDataNodeList<
                    (typeof seriesDataHere)["series"],
                    SingleData<string>,
                    string
                >(seriesDataHere.series);
                Object.entries(seriesDataNodeList).forEach(([key, value]) => {
                    // console.log(key);
                    const { depth } = value;
                    const codec = new UTF15({ depth, array: true, meta: true });
                    let data: (number | null)[] = codec.decode(value.data);
                    data = data.map(i => (i === POWERS_OF_2[depth] - 1 ? null : i));
                    // read mutations and insert extra data
                    const mutations = value.mutations;

                    if (mutations) {
                        const totalInsert = mutations.reduce((sum, [_, size]) => sum + size, 0);
                        const newDataArray = new Array<number | null>(data.length + totalInsert);
                        let readPos = 0;
                        let writePos = 0;
                        let lastMutationIndex = -1;
                        for (const [mutationIndex, size] of mutations) {
                            // copy from readPos
                            for (let i = lastMutationIndex + 1; i < mutationIndex + 1; i++) {
                                newDataArray[writePos++] = data[readPos++];
                            }
                            // insert size times data[mutationIndex]
                            const value = data[mutationIndex];
                            for (let i = 0; i < size; i++) {
                                newDataArray[writePos++] = value;
                            }
                            lastMutationIndex = mutationIndex;
                        }
                        // copy remaining
                        for (let i = readPos; i < data.length; i++) {
                            newDataArray[writePos++] = data[i];
                        }
                        data = newDataArray;
                        // console.log(data);
                    }

                    // push data
                    if (!this.seriesDataNodeListReadCache[key]) {
                        this.seriesDataNodeListReadCache[key] = {
                            ...value,
                            data: new Array(this.storeNumReadCache).fill(null) as (number | null)[]
                        } as SingleData<(number | null)[]>;
                    }
                    if (this.seriesDataNodeListReadCache[key].mutations) {
                        delete this.seriesDataNodeListReadCache[key].mutations;
                    }
                    if (!isArray(this.seriesDataNodeListReadCache[key].data)) {
                        this.seriesDataNodeListReadCache[key].data = data;
                    } else {
                        this.seriesDataNodeListReadCache[key].data.push(...data);
                    }
                });
                this.storeNumReadCache += seriesDataHere.storeNum;
                Object.entries(this.seriesDataNodeListReadCache).forEach(([key, value]) => {
                    // 将该份cache不存在的数据补全为null
                    const { data } = value;
                    // console.log(`${dataId}, ${key}:${data.length}, ${data}`);
                    if (data.length < this.storeNumReadCache) {
                        data.push(...new Array(this.storeNumReadCache - data.length).fill(null));
                    }
                });
            });
        }

        if (this.seriesDataReadNextIdList.includes(this.timeData.activeId)) {
            this.seriesDataReadEnd = true;
            // 如果this.timeData.activeId在this.seriesDataReadNextIdList里，那其必然为最后一个元素。
        }

        if (this.seriesDataReadEnd) {
            return setDataNodeList(this.seriesDataNodeListReadCache);
        } else {
            this.seriesDataReadNextIdList = this.getNextSegmentIdList(
                this.seriesDataReadNextIdList[this.seriesDataReadNextIdList.length - 1],
                this.opts.readDataBatchSize,
                this.timeData.activeId
            );
            this.opts.segmentManager.addId(this.seriesDataReadNextIdList);
            // logger.debug(`${this.seriesDataReadNextIdList}`);
            return false;
        }
    }

    public rawDataNodeListReadCache: string[] = new Array(100).fill("");
    public rawDataReadNextIdList: number[] = [];
    public rawDataReadEnd = false;

    /**
     * 获取segment的原始数据，用于外部解析数据。第一次执行应传入start为true。需要每个tick连续调用，直到返回数据为止。
     *
     * 返回的是类似segment的数组。数据被存储在对应的位置上，以便于外部解析。
     */
    public readRawData(start: boolean): string[] | false | null {
        if (this.timeData.getWritingIdTick !== -1) {
            return false;
        }
        const dataStorage = new TimeSeriesDataStorage(
            this.timeData.idList,
            this.opts.maxSegmentSize,
            this.opts.segmentManager
        );
        if (start) {
            this.rawDataNodeListReadCache = new Array(100).fill("");
            this.rawDataReadNextIdList = this.getNextSegmentIdList(
                this.timeData.activeId,
                this.opts.readDataBatchSize,
                this.timeData.activeId
            );
            this.rawDataReadEnd = false;
            this.opts.segmentManager.addId(this.rawDataReadNextIdList);
            // logger.debug(`${this.seriesDataReadNextIdList}`);
            return false;
        }

        if (!this.rawDataReadEnd) {
            this.rawDataReadNextIdList.forEach(dataId => {
                const rawSeriesDataHere = dataStorage.getRawData(dataId);
                if (rawSeriesDataHere === null || isEmpty(rawSeriesDataHere)) {
                    return;
                }
                this.rawDataNodeListReadCache[dataId] = rawSeriesDataHere;
            });
        }

        if (this.rawDataReadNextIdList.includes(this.timeData.activeId)) {
            this.rawDataReadEnd = true;
            // 如果this.timeData.activeId在this.seriesDataReadNextIdList里，那其必然为最后一个元素。
        }

        if (this.rawDataReadEnd) {
            return this.rawDataNodeListReadCache;
        } else {
            this.rawDataReadNextIdList = this.getNextSegmentIdList(
                this.rawDataReadNextIdList[this.rawDataReadNextIdList.length - 1],
                this.opts.readDataBatchSize,
                this.timeData.activeId
            );
            this.opts.segmentManager.addId(this.rawDataReadNextIdList);
            // logger.debug(`${this.seriesDataReadNextIdList}`);
            return false;
        }
    }

    public seriesDataClearNextIdList: number[] = [];
    public seriesDataClearEnd = false;
    public clearData(start: boolean): boolean {
        if (start) {
            this.seriesDataClearNextIdList = this.getNextSegmentIdList(
                this.timeData.activeId,
                this.opts.readDataBatchSize,
                this.timeData.activeId
            );
            this.seriesDataClearEnd = false;
            this.opts.segmentManager.addId(this.seriesDataClearNextIdList);
            // logger.debug(`${this.seriesDataReadNextIdList}`);
            return false;
        }

        if (!this.seriesDataClearEnd) {
            this.seriesDataClearNextIdList.forEach(dataId => {
                this.opts.segmentManager.writeSegment(dataId, "");
            });
        }

        if (this.seriesDataClearNextIdList.includes(this.timeData.activeId)) {
            this.seriesDataClearEnd = true;
        }

        if (this.seriesDataClearEnd) {
            return true;
        } else {
            this.seriesDataClearNextIdList = this.getNextSegmentIdList(
                this.seriesDataClearNextIdList[this.seriesDataClearNextIdList.length - 1],
                this.opts.readDataBatchSize,
                this.timeData.activeId
            );
            this.opts.segmentManager.addId(this.seriesDataClearNextIdList);
            // logger.debug(`${this.seriesDataReadNextIdList}`);
            return false;
        }
    }
    public getStorageUsedRatio() {
        const dataStorage = new TimeSeriesDataStorage(
            this.timeData.idList,
            this.opts.maxSegmentSize,
            this.opts.segmentManager
        );
        return dataStorage.getUsedRatio();
    }
    /**
     * 获得位深度总和。
     *
     * @returns {number}
     * @memberof TimeSeriesDataEngine
     */
    public getDepthSum(): number {
        const dataInThisTick = this.getDataInThisTick(false);
        const nodeList = getDataNodeList<T, SingleData<number>, number>(dataInThisTick);
        return Object.values(nodeList).reduce((lastValue, node) => {
            lastValue += node.depth;
            return lastValue;
        }, 0);
    }
    /**
     * 获得一天产生的平均数据量，以字节为单位
     *
     * @returns {number}
     * @memberof TimeSeriesDataEngine
     */
    public getDataSizePerDay(): number {
        const depthNum = this.getDepthSum();
        const dayTime = 86400 * 1000;
        const interval = this.opts.interval;
        return ((dayTime / interval) * depthNum) / 15;
    }
}
