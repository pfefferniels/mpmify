import { MPM } from "mpm-ts";

type WithCreated = { created: string[] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T extends WithCreated = WithCreated> = new (...args: any[]) => T;
type RecordableMethod = 'insertDefinition' | 'insertInstruction' | 'insertStyle';

// A helper that, given a method name and its arguments, returns the ID to log.
function getIdToRecord(method: RecordableMethod, args: unknown[]): string {
    const record = args[0] as Record<string, string>;
    switch (method) {
        case 'insertDefinition':
            return record.name;
        case 'insertInstruction':
            return record["xml:id"];
        case 'insertStyle':
            return record["xml:id"];
    }
}

function RecordMethods(...methods: RecordableMethod[]) {
    return function <T extends Constructor>(constructor: T) {
        return class extends constructor {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            constructor(...args: any[]) {
                super(...args);
                methods.forEach(methodName => {
                    const original = (this as Record<string, unknown>)[methodName];
                    if (typeof original === 'function') {
                        (this as Record<string, unknown>)[methodName] = (...methodArgs: unknown[]) => {
                            const result = (original as (...args: unknown[]) => unknown).apply(this, methodArgs);
                            this.created.push(getIdToRecord(methodName, methodArgs));
                            return result;
                        };
                    }
                });
            }
        };
    };
}

@RecordMethods('insertInstruction')
export class MPMRecording extends MPM {
    created: string[] = [];

    constructor(rawMPM: MPM) {
        super()
        this.doc = rawMPM.doc
    }
}
