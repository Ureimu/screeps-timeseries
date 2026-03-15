import cloneDeep from "lodash-es/cloneDeep";

let activeIdList: number[] = [];
let nowTickActiveIdList: number[] = [];
let writtenIdList: number[] = [];
let lastWriteTick: number = 0;

export class TimeSeriesSegmentManager {
    public constructor(
        public segmentCache = new Array(100).fill(""),
        public setActiveSegments = (ids: number[]) => null,
        public timeGetter = () => 0
    ) {}

    public addId(idList: number[]): number[] {
        const idAddedIntoList: number[] = [];
        const idListClone = cloneDeep(idList);

        while (activeIdList.length < 10) {
            const popId = idListClone.pop();
            if (typeof popId !== "number") break;

            activeIdList.push(popId);
            idAddedIntoList.push(popId);
        }

        return idAddedIntoList;
    }

    public getActiveLength() {
        return activeIdList.length;
    }

    public activeSegment(): void {
        if (activeIdList.length > 0) {
            this.setActiveSegments(cloneDeep(activeIdList));

            nowTickActiveIdList = cloneDeep(activeIdList);
            activeIdList = [];
        }
    }

    public readSegment(id: number): string {
        return this.segmentCache[id];
    }

    // 每tick只能读取最多10个segment，多于10个会直接报错，且之前存的也无效。
    public writeSegment(id: number, data: string): void {
        if (lastWriteTick != this.timeGetter()) {
            lastWriteTick = this.timeGetter();
            writtenIdList = [];
        }
        if (writtenIdList.length >= 10) throw new Error("cannot write more than 10 segments in one tick");
        if (!writtenIdList.includes(id)) writtenIdList.push(id);
        this.segmentCache[id] = data;
    }

    public isActive(id: number): boolean {
        return nowTickActiveIdList.some(idHere => idHere === id);
    }
}
