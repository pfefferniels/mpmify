export type DefinedProperty<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

export const isDefined = (onset?: number) => {
    return onset !== undefined && !isNaN(onset)
}

/**
 * Returns a number whose value is limited to the given range.
 */
export const clamp = (min: number, middle: number, max: number) => {
    return Math.max(min, Math.min(middle, max))
}

export const toFixed = (num: number, precision: number) => {
    return +(+(Math.round(+(num + 'e' + precision)) + 'e' + -precision)).toFixed(precision);
}

export const fix = <T extends object>(obj: T, key: keyof T, precision: number) => {
    const property = obj[key]
    if (property && typeof property === 'number') (obj[key] as number) = toFixed(property, precision)
}
