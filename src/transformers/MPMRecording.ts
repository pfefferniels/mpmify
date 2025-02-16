import { MPM } from "mpm-ts";

type WithCreated = { created: string[] }
type Constructor<T extends WithCreated = WithCreated> = new (...args: any[]) => T;
type RecordableMethod = 'insertDefinition' | 'insertInstruction' | 'insertStyle';

// A helper that, given a method name and its arguments, returns the ID to log.
function getIdToRecord(method: RecordableMethod, args: any[]): string {
    switch (method) {
        case 'insertDefinition':
            return args[0].name;
        case 'insertInstruction':
            return args[0]["xml:id"];
        case 'insertStyle':
            return args[0]["xml:id"];
    }
}

function RecordMethods(...methods: RecordableMethod[]) {
    return function <T extends Constructor>(constructor: T) {
        return class extends constructor {
            constructor(...args: any[]) {
                super(...args);
                methods.forEach(methodName => {
                    const original = (this as any)[methodName];
                    if (typeof original === 'function') {
                        (this as any)[methodName] = (...methodArgs: any[]) => {
                            const result = original.apply(this, methodArgs);
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
