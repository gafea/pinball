/**
 * This module manages view groups and views. A view group is a set of views where only one can be shown at a time.
 */
const View = (function() {

    // This stores the available view groups and their views. 
    // [className] = [viewId1, viewId2, ...]
    const viewGroups = {};

    // This stores the mapping from view id to its view group.
    // [viewId] = className
    const viewTable = {};

    /**
     * Register one or more views to a view group. 
     * @param {String} className 
     * @param  {...String} ids 
     */
    const register = function(className, ...ids) {
        if (!(className in viewGroups)) viewGroups[className] = [];
        for (const id of ids) {
            if ($(`#${id}`).length === 0) {
                console.warn(`View with id ${id} does not exist in the DOM.`);
            }
            viewGroups[className].push(id);

            if (id in viewTable) {
                console.warn(`View with id ${id} is already registered to view group ${viewTable[id]}.`);
            }
            viewTable[id] = className;
        }
    }

    /**
     * Show a view and hide all other views in its view group. 
     * @param {String} id 
     */
    const show = function(id) {
        const className = viewTable[id];
        if (!className) {
            console.warn(`View with id ${id} is not registered.`);
            return;
        }
        $(`.${className}`).hide();
        $(`#${id}`).show();
    }

    return { register, show };
})();
