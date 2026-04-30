import { assert } from "chai";
import { TimeSeriesDataEngine } from "../../src/engine";
import { TimeSeriesSegmentManager } from "../../src/TimeSeriesSegmentManager";
import { SingleTypedTreeData, SingleData } from "../../src/type";
import { UTF15 } from "../../src/utils/utf15";

describe("engine should run", () => {
    it("should read right data if some leading segments does not have the key", () => {
        // Create actual segment manager
        let timeCounter = 5;
        const segmentManager = new TimeSeriesSegmentManager(
            new Array(100).fill(""),
            (ids: number[]) => null,
            () => timeCounter
        );

        // Mock time data
        let timeData = {
            lastRecordTime: 0,
            interval: 15 * 60 * 1000,
            idList: [0, 1, 2],
            activeId: 2,
            storeStartTick: 0,
            switchWritingIdTick: 0,
            getWritingIdTick: -1
        };

        const timeDataFunc = () => timeData;

        // Data getter that returns sample data
        const dataGetter = (store: boolean): SingleTypedTreeData<SingleData<number>> => ({
            testKey: { data: 42, type: "number", depth: 7 },
            timeStamp: { data: Date.now(), type: "time", depth: 41 },
            gameTime: { data: timeCounter, type: "time", depth: 41 }
        });

        const engine = new TimeSeriesDataEngine(dataGetter, {
            segmentManager,
            timeData: timeDataFunc,
            timeGetter: () => timeCounter,
            idList: [0, 1, 2],
            readDataBatchSize: 1
        });

        // Create encoder
        const codec = new UTF15({ depth: 7, array: true, meta: true });
        const codecTime = new UTF15({ depth: 41, array: true, meta: true });

        // Simulate stored data in segments
        // Segment 2 (active) has data for testKey
        const segment2Data = {
            series: {
                testKey: { data: codec.encode([42]), type: "number", depth: 7 },
                timeStamp: { data: codecTime.encode([Date.now() - 1000]), type: "time", depth: 41 },
                gameTime: { data: codecTime.encode([2]), type: "time", depth: 41 }
            },
            storeNum: 1,
            isWriting: true
        };
        segmentManager.segmentCache[2] = JSON.stringify(segment2Data);

        // Segment 1 has data for testKey
        const segment1Data = {
            series: {
                testKey: { data: codec.encode([42]), type: "number", depth: 7 },
                timeStamp: { data: codecTime.encode([Date.now() - 2000]), type: "time", depth: 41 },
                gameTime: { data: codecTime.encode([1]), type: "time", depth: 41 }
            },
            storeNum: 1,
            isWriting: false
        };
        segmentManager.segmentCache[1] = JSON.stringify(segment1Data);

        // Segment 0 has data for testKey
        const segment0Data = {
            series: {
                otherKey: { data: codec.encode([6]), type: "number", depth: 7 },
                timeStamp: { data: codecTime.encode([Date.now() - 3000]), type: "time", depth: 41 },
                gameTime: { data: codecTime.encode([0]), type: "time", depth: 41 }
            },
            storeNum: 1,
            isWriting: false
        };
        segmentManager.segmentCache[0] = JSON.stringify(segment0Data);

        // Start reading
        timeCounter++;
        let result = engine.readData(true);
        assert.isFalse(result, "Should return false when starting read");

        // Continue reading until data is returned
        while (true) {
            timeCounter++;
            result = engine.readData(false);
            if (result !== false) break;
        }
        assert.isObject(result, "Should return data object");

        // Check that testKey has correct data with nulls for missing segments
        const testKeyData = (result as any).testKey.data;
        assert.isArray(testKeyData, "Data should be an array");
        // Reading order: 0,1,2
        // Segment 0: no data -> skip
        // Segment 1: has data -> [42]
        // Segment 2: has data -> append [42] -> [42,42]
        // Total storeNum = 1+1+1=3, so fill with null: [null,42,42]
        assert.deepEqual(testKeyData, [null, 42, 42], "Should have null for missing key in segment 1");
    });

    it("should decode signed data correctly (positive, negative, and null)", () => {
        let timeCounter = 5;
        const segmentManager = new TimeSeriesSegmentManager(
            new Array(100).fill(""),
            (ids: number[]) => null,
            () => timeCounter
        );

        let timeData = {
            lastRecordTime: 0,
            interval: 15 * 60 * 1000,
            idList: [0],
            activeId: 0,
            storeStartTick: 0,
            switchWritingIdTick: 0,
            getWritingIdTick: -1
        };

        const timeDataFunc = () => timeData;

        const dataGetter = (store: boolean): SingleTypedTreeData<SingleData<number>> => ({
            timeStamp: { data: Date.now(), type: "time", depth: 41 },
            gameTime: { data: timeCounter, type: "time", depth: 41 }
        });

        const engine = new TimeSeriesDataEngine(dataGetter, {
            segmentManager,
            timeData: timeDataFunc,
            timeGetter: () => timeCounter,
            idList: [0],
            readDataBatchSize: 1
        });

        const codec = new UTF15({ depth: 8, array: true, meta: true });
        const codecTime = new UTF15({ depth: 41, array: true, meta: true });

        // depth=8: nullValue=255, signedOffset=128, signedMax=126, signedMin=-128
        // Encode signed values with offset:
        //   null → 255
        //   -5  → -5 + 128 = 123
        //   42  → 42 + 128 = 170
        const segment0Data = {
            series: {
                signedKey: {
                    data: codec.encode([255, 123, 170]),
                    type: "number",
                    depth: 8,
                    signed: true
                },
                unsignedKey: {
                    data: codec.encode([42, 100, 255]),
                    type: "number",
                    depth: 8
                },
                timeStamp: { data: codecTime.encode([Date.now(), Date.now(), Date.now()]), type: "time", depth: 41 },
                gameTime: { data: codecTime.encode([0, 1, 2]), type: "time", depth: 41 }
            },
            storeNum: 3,
            isWriting: false
        };
        segmentManager.segmentCache[0] = JSON.stringify(segment0Data);

        // Start reading
        timeCounter++;
        let result = engine.readData(true);
        assert.isFalse(result);

        while (true) {
            timeCounter++;
            result = engine.readData(false);
            if (result !== false) break;
        }

        assert.isObject(result);
        const signedData = (result as any).signedKey.data;
        const unsignedData = (result as any).unsignedKey.data;

        // signedKey should decode to [null, -5, 42]
        assert.deepEqual(
            signedData,
            [null, -5, 42],
            "Signed key should decode: null→null, negative preserved, positive preserved"
        );
        // unsignedKey should decode to [42, 100, null]
        assert.deepEqual(unsignedData, [42, 100, null], "Unsigned key should remain unchanged, null sentinel works");
    });
});
