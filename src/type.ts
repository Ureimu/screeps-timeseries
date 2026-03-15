export type SingleTypedTreeDataNode<T> = T | SingleTypedTreeDataRecord<T>;

// 下面定义了一个树类型，需要借用接口的特性，参见https://stackoverflow.com/questions/46216048
// 除非你有更好的方案，否则不要去掉下面的eslint-disable-next-line
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface SingleTypedTreeDataRecord<T> extends Record<string, SingleTypedTreeDataNode<T>> {}
export type SingleTypedTreeData<T> = Record<string, SingleTypedTreeDataNode<T>> & { timeStamp?: T; gameTime?: T };
export interface SingleData<T extends (number | null)[] | string | number> {
    data: T;
    type: string;
    depth: number;
    /**
     * 指示该数据在使用时需要乘以10的多少次方。
     */
    exp?: number;
    mutations?: T extends number[] | string ? [mutationIndex: number, size: number][] : undefined;
}

export interface TimeSeriesEngineOpts {
    /**
     * 是否收集数据。
     */
    ifGatherData: boolean;
    /**
     * 执行存储数据的时间间隔，以毫秒为单位。
     */
    interval: number;
    /**
     * 当单个segment存储多少数据时，才切换到下一个segment。
     */
    maxSegmentSize: number;
    /**
     * 用于存储数据的segment id列表。
     */
    idList: number[];
    /**
     * 当数据重复条数达到多少时，才使用mutation合并重复数据。
     */
    mutationSize: number;
    /**
     * 单次读取数据，读取多少个segment。
     */
    readDataBatchSize: number;

    /**
     * segment manager。在游戏内使用时应传入SegmentManager对象（可使用TimeSeriesSegmentManager构建）
     *
     * TimeSeriesSegmentManager构建时需要传入RawMemory的相关方法。
     *
     * 在游戏外使用则使用默认设置即可。
     */
    segmentManager: {
        addId(idList: number[]): number[];
        getActiveLength(): number;
        activeSegment(): void;
        readSegment(id: number): string;
        writeSegment(id: number, data: string): void;
        isActive(id: number): boolean;
    };

    /**
     * 存储TimeSeriesEngineData的位置。
     */
    timeData(): TimeSeriesEngineData;

    timeGetter(): number;
}

export interface TimeSeriesEngineData {
    /**
     * 上次记录数据的现实时间戳。
     */
    lastRecordTime: number;
    /**
     * 记录数据的现实时间间隔。与时间戳同单位，为ms。
     */
    interval: number;
    /**
     * 当前使用的存储数据用的segmentId列表。
     */
    idList: number[];
    /**
     * 当前在使用的segmentId, -1为未初始化。
     */
    activeId: number;
    /**
     * 开始存储数据的tick。
     */
    storeStartTick: number;
    /**
     * 切换当前在写的segmentId的tick。
     */
    switchWritingIdTick: number;
    /**
     * 获取writingId的上次时间。-1为已经获取。-2为未初始化。
     */
    getWritingIdTick: number;
}
