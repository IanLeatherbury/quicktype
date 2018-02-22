"use strict";

import * as _ from "lodash";

import { Set, List, Map, OrderedMap, OrderedSet, Collection } from "immutable";

import {
    Type,
    EnumType,
    NamedType,
    UnionType,
    ClassType,
    nullableFromUnion,
    matchTypeExhaustive,
    directlyReachableSingleNamedType
} from "../Type";
import { TypeGraph } from "../TypeGraph";

import { Sourcelike } from "../Source";
import {
    legalizeCharacters,
    splitIntoWords,
    combineWords,
    firstUpperWordStyle,
    allUpperWordStyle,
    allLowerWordStyle,
    isAscii,
    isLetterOrUnderscoreOrDigit
} from "../Strings";
import { intercalate, panic } from "../Support";

import { Namer, Name } from "../Naming";

import { ConvenienceRenderer, ForbiddenWordsInfo } from "../ConvenienceRenderer";

import { Renderer, RenderResult, BlankLineLocations } from "../Renderer";

import { TargetLanguage } from "../TargetLanguage";
import { BooleanOption } from "../RendererOptions";
import { StringTypeMapping } from "../TypeBuilder";

const unicode = require("unicode-properties");

export default class PythonTargetLanguage extends TargetLanguage {
    private readonly _declareUnionsOption = new BooleanOption("declare-unions", "Declare unions as named types", false);

    constructor() {
        super("Python", ["python"], "py");
        this.setOptions([this._declareUnionsOption]);
    }

    protected get partialStringTypeMapping(): Partial<StringTypeMapping> {
        return { date: "date", time: "time", dateTime: "date-time" };
    }

    get supportsOptionalClassProperties(): boolean {
        return true;
    }

    protected get rendererClass(): new (
        graph: TypeGraph,
        leadingComments: string[] | undefined,
        ...optionValues: any[]
    ) => ConvenienceRenderer {
        return PythonTypesRenderer;
    }
}

function isStartCharacter(utf16Unit: number): boolean {
    return unicode.isAlphabetic(utf16Unit) || utf16Unit === 0x5f; // underscore
}

function isPartCharacter(utf16Unit: number): boolean {
    const category: string = unicode.getCategory(utf16Unit);
    return _.includes(["Nd", "Pc", "Mn", "Mc"], category) || isStartCharacter(utf16Unit);
}

const forbiddenNames = ["type", "id"];

const legalizeName = legalizeCharacters(cp => isAscii(cp) && isLetterOrUnderscoreOrDigit(cp));

function pythonNameStyle(original: string, uppercase: boolean): string {
    const words = splitIntoWords(original);
    return combineWords(
        words,
        legalizeName,
        uppercase ? firstUpperWordStyle : allLowerWordStyle,
        firstUpperWordStyle,
        uppercase ? allUpperWordStyle : allLowerWordStyle,
        allUpperWordStyle,
        "",
        isStartCharacter
    );
}

class PythonTypesRenderer extends ConvenienceRenderer {
    constructor(graph: TypeGraph, leadingComments: string[] | undefined, private readonly inlineUnions: boolean) {
        super(graph, leadingComments);
    }

    protected get forbiddenNamesForGlobalNamespace(): string[] {
        return forbiddenNames;
    }

    protected topLevelNameStyle(rawName: string): string {
        return pythonNameStyle(rawName, true);
    }

    protected makeNamedTypeNamer(): Namer {
        return new Namer("types", n => pythonNameStyle(n, true), []);
    }

    protected namerForClassProperty(): Namer {
        return new Namer("properties", n => pythonNameStyle(n, false), []);
    }

    protected forbiddenForClassProperties(_c: ClassType, _className: Name): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected makeUnionMemberNamer(): null {
        return null;
    }

    protected makeEnumCaseNamer(): Namer {
        return new Namer("enum-cases", n => pythonNameStyle(n, true), []);
    }

    protected namedTypeToNameForTopLevel(type: Type): Type | undefined {
        return directlyReachableSingleNamedType(type);
    }

    sourceFor = (t: Type): Sourcelike => {
        return matchTypeExhaustive<Sourcelike>(
            t,
            _noneType => {
                return panic("None type should have been replaced");
            },
            _anyType => "Any",
            _nullType => "None",
            _boolType => "bool",
            _integerType => "int",
            _doubleType => "float",
            _stringType => "str",
            arrayType => ["list[", this.sourceFor(arrayType.items), "]"],
            classType => this.nameForNamedType(classType),
            mapType => ["Map[str, ", this.sourceFor(mapType.values), "]"],
            enumType => this.nameForNamedType(enumType),
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) return ["Optional[", this.sourceFor(nullable), "]"];

                if (this.inlineUnions) {
                    const children = unionType.children.map((c: Type) => this.sourceFor(c));
                    return intercalate(" | ", children).toArray();
                } else {
                    return this.nameForNamedType(unionType);
                }
            },
            _dateType => "date",
            _timeType => "time",
            _dateTimeType => "datetime"
        );
    };

    private emitClass = (c: ClassType, className: Name) => {
        this.emitLine("class ", className, "(object):");
        this.indent(() => {
            this.emitLine("def __init__(self,");
            this.indent(() => {
                this.forEachClassProperty(c, "none", (name, _jsonName, p) => {
                    this.indent(() => {
                        this.emitLine(name, ": ", this.sourceFor(p.type), ",");
                    });
                });
                this.emitLine("):");
            });
        });
        this.indent(() => {
            this.forEachClassProperty(c, "none", (name, _jsonName) => {
                this.indent(() => {
                    this.emitLine("self.", name, " = ", name);
                });
            });
        });
    };

    emitEnum = (e: EnumType, enumName: Name) => {
        this.emitLine("class ", enumName, "(Enum):");
        let count = 0;
        this.indent(() => {
            this.forEachEnumCase(e, "none", name => {
                this.emitLine(name, " = ", (count++).toString());
            });
        });
        this.emitLine();
    };

    emitUnion = (u: UnionType, unionName: Name) => {
        this.emitLine(unionName, " = Union[");
        this.indent(() => {
            this.forEach(u.members, false, false, (t: Type) => {
                this.emitLine(this.sourceFor(t), ",");
            });
        });
        this.emitLine("]");
    };

    // Have to reverse class order because Python will not reference a type
    // before it is declared
    protected forEachSpecificNamedType<T extends NamedType>(
        blankLocations: BlankLineLocations,
        types: OrderedSet<T>,
        f: (t: T, name: Name) => void
    ): void {
        this.forEachWithBlankLines(types.reverse(), blankLocations, t => {
            this.callForNamedType(t, f);
        });
    }

    protected emitSourceStructure() {
        if (this.leadingComments !== undefined) {
            this.emitCommentLines("# ", this.leadingComments);
        }

        this.forEachNamedType("leading-and-interposing", this.emitClass, this.emitEnum);
    }
}
