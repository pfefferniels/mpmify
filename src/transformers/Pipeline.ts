import { AbstractTransformer, TransformationOptions } from "./Transformer";

type Transformer = AbstractTransformer<TransformationOptions>

export class Pipeline {
    head: Transformer | null
    length: number

    constructor(head?: Transformer) {
        if (head) {
            this.head = head
            this.length = 1
        }
        else {
            this.head = null
            this.length = 0
        }
    }

    push(transformer: Transformer) {
        if (!this.head) {
            this.head = transformer
            this.length = 1
            return;
        }

        let current = this.head;
        while (current.nextTransformer) {
            current = current.nextTransformer;
        }
        current.setNext(transformer)
        this.length += 1
    }

    at(n: number): Transformer | null {
        if (n > this.length || n < 0) return null
        if (n === 0) return this.head
        let current = this.head
        for (let i = 0; i < n; i++) {
            if (!current?.nextTransformer) return null
            current = current.nextTransformer
        }
        return current
    }

    erase(n: number) {
        // TODO 
    }

    insert(n: number, transformer: Transformer) {
        // TODO
    }

    map<T>(callback: (transformer: Transformer, index: number) => T): T[] {
        const result = []
        let current: Transformer | undefined | null = this.head
        let counter = 0;
        while (current) {
            result.push(callback(current, counter))
            current = current.nextTransformer;
            counter++
        }
        return result
    }
}

