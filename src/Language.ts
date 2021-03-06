// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation.  All rights reserved.
// ----------------------------------------------------------------------------

import * as assert from "assert";
import { nonNullValue } from "./util/nonNull";

/**
 * A span representing the character indexes that are contained by a JSONToken.
 */
export class Span {
    constructor(private _startIndex: number, private _length: number) {
    }

    /**
     * Get the start index of this span.
     */
    public get startIndex(): number {
        return this._startIndex;
    }

    /**
     * Get the length of this span.
     */
    public get length(): number {
        return this._length;
    }

    /**
     * Get the last index of this span.
     */
    public get endIndex(): number {
        return this._startIndex + (this._length > 0 ? this._length - 1 : 0);
    }

    /**
     * Get the index directly after this span.
     *
     * If this span started at 3 and had a length of 4 ([3,7)), then the after
     * end index would be 7.
     */
    public get afterEndIndex(): number {
        return this._startIndex + this._length;
    }

    /**
     * Determine if the provided index is contained by this span.
     *
     * If this span started at 3 and had a length of 4 ([3, 7)), then all
     * indexes between 3 and 6 (inclusive) would be contained. 2 and 7 would
     * not be contained.
     */
    public contains(index: number, includeAfterEndIndex: boolean = false): boolean {
        let result: boolean = this._startIndex <= index;
        if (result) {
            if (includeAfterEndIndex) {
                result = index <= this.afterEndIndex;
            } else {
                result = index <= this.endIndex;
            }
        }
        return result;
    }

    /**
     * Create a new span that is a union of this Span and the provided Span.
     * If the provided Span is undefined, then this Span will be returned.
     */
    public union(rhs: Span | undefined): Span {
        let result: Span;
        if (!!rhs) {
            let minStart = Math.min(this.startIndex, rhs.startIndex);
            let maxAfterEndIndex = Math.max(this.afterEndIndex, rhs.afterEndIndex);
            result = new Span(minStart, maxAfterEndIndex - minStart);
        } else {
            result = this;
        }
        return result;
    }

    /**
     * Create a new span that is a union of the given spans.
     * If both are undefined, undefined will be returned
     */
    public static union(lhs: Span | undefined, rhs: Span | undefined): Span | undefined {
        if (lhs) {
            return lhs.union(rhs);
        } else if (rhs) {
            return rhs;
        } else {
            return undefined;
        }
    }

    public translate(movement: number): Span {
        return movement === 0 ? this : new Span(this._startIndex + movement, this._length);
    }

    public toString(): string {
        return `[${this.startIndex}, ${this.afterEndIndex})`;
    }
}

export class Position {
    constructor(private _line: number, private _column: number) {
        nonNullValue(_line, "_line");
        assert(_line >= 0, "_line cannot be less than 0");
        nonNullValue(_column, "_column");
        assert(_column >= 0, "_column cannot be less than 0");
    }

    public get line(): number {
        return this._line;
    }

    public get column(): number {
        return this._column;
    }

    public toFriendlyString(): string {
        return `[${this._line + 1}:${this._column + 1}]`;
    }
}

export enum IssueKind {
    tleSyntax = "tleSyntax",
    referenceInVar = "referenceInVar",
    unusedVar = "unusedVar",
    unusedParam = "unusedParam",
    unusedUdfParam = "unusedUdfParam",
    unusedUdf = "unusedUdf",
    badArgsCount = "badArgsCount",
    badFuncContext = "badFuncContext",
    undefinedFunc = "undefinedFunc",
    undefinedNs = "undefinedNs",
    undefinedUdf = "undefinedUdf",
    undefinedParam = "undefinedParam",
    undefinedVar = "undefinedVar",
    varInUdf = "varInUdf",
    undefinedVarProp = "undefinedVarProp"
}

/**
 * An issue that was detected while parsing a deployment template.
 */
export class Issue {
    constructor(private _span: Span, private _message: string, public kind: IssueKind) {
        nonNullValue(_span, "_span");
        assert(1 <= _span.length, "_span's length must be greater than or equal to 1.");
        nonNullValue(_message, "_message");
        assert(_message !== "", "_message must not be empty.");
    }

    public get span(): Span {
        return this._span;
    }

    public get message(): string {
        return this._message;
    }

    public translate(movement: number): Issue {
        return new Issue(this._span.translate(movement), this._message, this.kind);
    }
}
