/*
 * History Manager
 *
 * Unified undo/redo command stack covering annotations, blur regions,
 * destructive filters, crops, perspective warps, and preset
 * applications. Each command supplies its own undo()/redo() closures;
 * commands are stored in strict chronological order so Ctrl+Z always
 * reverts the most recent action regardless of its type — fixing the
 * old behavior where blurs were always undone before annotations.
 *
 * The stack doubles as an audit trail: onChange receives the labeled
 * command list so the UI can display what has been done to the image.
 */

export class HistoryManager {
    constructor(maxDepth = 50) {
        // Initializes empty undo/redo stacks with a depth cap
        this.undoStack = [];
        this.redoStack = [];
        this.maxDepth = maxDepth;
        this.onChange = null;
    }

    push(command) {
        // Records a new command; clears the redo branch
        this.undoStack.push(command);
        if (this.undoStack.length > this.maxDepth) this.undoStack.shift();
        this.redoStack = [];
        this.notify();
    }

    undo() {
        // Reverts the most recent command
        const cmd = this.undoStack.pop();
        if (!cmd) return false;
        cmd.undo();
        this.redoStack.push(cmd);
        this.notify();
        return true;
    }

    redo() {
        // Re-applies the most recently undone command
        const cmd = this.redoStack.pop();
        if (!cmd) return false;
        cmd.redo();
        this.undoStack.push(cmd);
        this.notify();
        return true;
    }

    clear() {
        // Empties both stacks (new image loaded)
        this.undoStack = [];
        this.redoStack = [];
        this.notify();
    }

    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }

    entries() {
        // Returns labels of all recorded commands, oldest first
        return this.undoStack.map(c => c.label);
    }

    notify() {
        // Fires the change callback for UI updates
        if (this.onChange) this.onChange(this);
    }
}
