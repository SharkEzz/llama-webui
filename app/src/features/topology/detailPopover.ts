import { Popover } from '@base-ui/react/popover';

/**
 * Ties every block of the drawing, a trigger, to the one popover of the details: a click on a block opens them
 * beside it, a click on another moves them there. Its payload is the id of the block.
 */
export const detailPopover = Popover.createHandle<string>();
