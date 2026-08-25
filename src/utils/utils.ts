export const isDefined = (onset?: number) => {
    return onset !== undefined && !isNaN(onset)
}

/**
 * `value`, held inside `[min, max]`.
 *
 * The argument order is value-first. It used to be `clamp(min, middle, max)` here while
 * `ApproximateLogarithmicTempo` declared a second `clamp(value, lo, hi)` of its own — two
 * functions of the same name, in the same package, whose arguments went in a different order.
 * Either order is defensible; having both is not, and value-first is the one the other four
 * call sites were already written against.
 */
export const clamp = (value: number, min: number, max: number) => {
    return Math.max(min, Math.min(value, max))
}

const toFixed = (num: number, precision: number) => {
    return +(+(Math.round(+(num + 'e' + precision)) + 'e' + -precision)).toFixed(precision);
}

export const fix = <T extends object>(obj: T, key: keyof T, precision: number) => {
    const property = obj[key]
    if (property && typeof property === 'number') (obj[key] as number) = toFixed(property, precision)
}
