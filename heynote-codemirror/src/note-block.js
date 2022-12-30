import { ViewPlugin, EditorView, Decoration, WidgetType, lineNumbers } from "@codemirror/view"
import { layer, RectangleMarker } from "@codemirror/view"
import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { RangeSet } from "@codemirror/rangeset";
import { syntaxTree } from "@codemirror/language"
import { Note, Document, NoteDelimiter } from "./lang-heynote/parser.terms.js"
import { IterMode } from "@lezer/common";
import { INITIAL_DATA } from "./annotation.js";


// tracks the size of the first delimiter
let firstBlockDelimiterSize

function getBlocks(state) {
    const blocks = [];
    syntaxTree(state).iterate({
        enter: (type) => {
            if (type.type.id == Document || type.type.id == Note) {
                return true
            } else if (type.type.id === NoteDelimiter) {
                const contentNode = type.node.nextSibling
                blocks.push({
                    content: {
                        from: contentNode.from,
                        to: contentNode.to,
                    },
                    delimiter: {
                        from: type.from,
                        to: type.to,
                    },
                })
                return false;
            }
            return false;
        },
        mode: IterMode.IgnoreMounts,
    });
    firstBlockDelimiterSize = blocks[0]?.delimiter.to
    return blocks
}

const blockState = StateField.define({
    create(state) {
        return getBlocks(state);
    },
    update(blocks, transaction) {
        //console.log("blocks", blocks)
        if (transaction.docChanged) {
            //console.log("updating block state", transaction)
            return getBlocks(transaction.state);
        }
        //return widgets.map(transaction.changes);
        return blocks
    },
})


class NoteBlockStart extends WidgetType {
    constructor() {
        super()
    }
    eq(other) {
        //return other.checked == this.checked
        return true
    }
    toDOM() {
        let wrap = document.createElement("div")
        wrap.className = "block-start"
        //wrap.innerHTML = "<br>"
        return wrap
    }
    ignoreEvent() {
        return false
    }
}
const noteBlockWidget = () => {
    const decorate = (state) => {
        const widgets = [];

        state.facet(blockState).forEach(block => {
            let delimiter = block.delimiter
            let deco = Decoration.replace({
                widget: new NoteBlockStart(),
                inclusive: true,
                block: true,
                side: 0,
            });
            //console.log("deco range:", delimiter.from === 0 ? delimiter.from : delimiter.from+1,delimiter.to-1)
            widgets.push(deco.range(
                delimiter.from === 0 ? delimiter.from : delimiter.from + 1,
                delimiter.to - 1,
            ));
        });

        return widgets.length > 0 ? RangeSet.of(widgets) : Decoration.none;
    };

    const noteBlockStartField = StateField.define({
        create(state) {
            return decorate(state);
        },
        update(widgets, transaction) {
            if (transaction.docChanged) {
                return decorate(transaction.state);
            }

            //return widgets.map(transaction.changes);
            return widgets
        },
        provide(field) {
            return EditorView.decorations.from(field);
        }
    });

    return noteBlockStartField;
};




function atomicRanges(view) {
    let builder = new RangeSetBuilder()
    view.state.facet(blockState).forEach(block => {
        builder.add(
            block.delimiter.from,
            block.delimiter.to,
            {},
        )
    })
    return builder.finish()
}
const atomicNoteBlock = ViewPlugin.fromClass(
    class {
        constructor(view) {
            this.atomicRanges = atomicRanges(view)
        }

        update(update) {
            if (update.docChanged) {
                this.atomicRanges = atomicRanges(update.view)
            }
        }
    },
    {
        provide: plugin => EditorView.atomicRanges.of(view => {
            return view.plugin(plugin)?.atomicRanges || []
        })
    }
)

const blockLayer = () => {
    let editorWidth = 0;
    const measureEditorWidth = EditorView.updateListener.of((update) => {
        if (update.geometryChanged) {
            update.view.requestMeasure({
                read(a) {
                    const gutterWidth = update.view.contentDOM.previousSibling.clientWidth
                    editorWidth = update.view.contentDOM.clientWidth + gutterWidth
                }
            })
        }
    })

    const layerExtension = layer({
        above: false,

        markers(view) {
            const markers = []
            let idx = 0
            //console.log("visible ranges:", view.visibleRanges[0].from, view.visibleRanges[0].to, view.visibleRanges.length)
            function rangesOverlaps(range1, range2) {
                return range1.from <= range2.to && range2.from <= range1.to
            }
            view.state.facet(blockState).forEach(block => {
                // make sure the block is visible
                if (!view.visibleRanges.some(range => rangesOverlaps(block.content, range))) {
                    idx++;
                    return
                }
                const fromCoords = view.coordsAtPos(Math.max(block.content.from, view.visibleRanges[0].from))
                const toCoords = view.coordsAtPos(Math.min(block.content.to, view.visibleRanges[view.visibleRanges.length - 1].to))
                markers.push(new RectangleMarker(
                    idx++ % 2 == 0 ? "block-even" : "block-odd",
                    0,
                    fromCoords.top - (view.documentTop - view.documentPadding.top) - 1,
                    editorWidth,
                    (toCoords.bottom - fromCoords.top) + 2,
                ))
            })
            return markers

        },

        update(update, dom) {
            return update.docChanged || update.viewportChanged
        },

        class: "blocks-layer"
    })

    return [measureEditorWidth, layerExtension]
}


const preventFirstBlockFromBeingDeleted = EditorState.changeFilter.of((tr) => {
    if (!tr.annotations.some(a => a.value === INITIAL_DATA) && firstBlockDelimiterSize) {
        return [0, firstBlockDelimiterSize]
    }
})

/**
 * Transaction filter to prevent the selection from being before the first block
  */
const preventSelectionBeforeFirstBlock = EditorState.transactionFilter.of((tr) => {
    if (!firstBlockDelimiterSize) {
        return tr
    }
    tr?.selection?.ranges.forEach(range => {
        // change the selection to after the first block if the transaction sets the selection before the first block
        if (range && range.from < firstBlockDelimiterSize) {
            range.from = firstBlockDelimiterSize
            //console.log("changing the from selection to", markerSize)
        }
        if (range && range.to < firstBlockDelimiterSize) {
            range.to = firstBlockDelimiterSize
            //console.log("changing the from selection to", markerSize)
        }
    })
    return tr
})


export const noteBlockExtension = () => {
    return [
        blockState,
        noteBlockWidget(),
        atomicNoteBlock,
        blockLayer(),
        preventFirstBlockFromBeingDeleted,
        preventSelectionBeforeFirstBlock,
        lineNumbers({
            formatNumber(lineNo, state) {
                if (state.doc.lines >= lineNo) {
                    const lineOffset = state.doc.line(lineNo).from
                    const block = state.facet(blockState).find(block => block.content.from <= lineOffset && block.content.to >= lineOffset)
                    if (block) {
                        const firstBlockLine = state.doc.lineAt(block.content.from).number
                        return lineNo - firstBlockLine + 1
                    }
                }
                return ""
            }
        }),
    ]
}
