"use strict";

/**
 * @file Abstraction module for the run/queue utilities for CNC Server!
 */

module.exports = function(cncserver) {
  var extend = require('util')._extend;      // Util for cloning objects

  // Buffer State variables
  cncserver.buffer = {
    dataSet: {},         // Holds the actual buffer data keyed by hash.
    data: [],            // Holds the order of the in a flat array of hashes.
    running: false,      // Are we running? True if items in buffer/not paused.
    paused: false,       // Are we paused?
    newlyPaused: false,  // Trigger for pause callback on executeNext()
    pauseCallback: null, // Temporary callback storage when pause is complete.
    pausePen: null,      // Hold the state when paused initiated for resuming
  };

  /**
   * Helper function for clearing the buffer. Used mainly by plugins.
   */
  cncserver.buffer.clear = function() {
    cncserver.buffer.data = [];

    // Reset the state of the buffer tip pen to the state of the actual robot.
    // If this isn't done, it will be assumed to be a state that was deleted
    // and never sent out.
    cncserver.pen = extend({}, cncserver.actualPen);
    cncserver.io.sendBufferVars();
  };


  // Pause the buffer running.
  cncserver.buffer.pause = function() {
    cncserver.buffer.paused = true;
    cncserver.ipc.sendMessage('buffer.pause');
    cncserver.io.sendBufferVars();
  };

  // Resume the buffer running.
  cncserver.buffer.resume = function() {
    cncserver.buffer.paused = false;
    cncserver.ipc.sendMessage('buffer.resume');
    cncserver.io.sendBufferVars();
  };

  // Toggle the state
  cncserver.buffer.toggle = function(setPause) {
    if (setPause && !cncserver.buffer.paused) {
      cncserver.buffer.pause();
    } else if (!setPause && cncserver.buffer.paused) {
      cncserver.buffer.resume();
    }
  };

  // Add an object to the buffer.
  cncserver.buffer.addItem = function(item) {
    var hash = cncserver.utils.getHash(item);
    cncserver.buffer.data.unshift(hash);
    cncserver.buffer.dataSet[hash] = item;

    // Add the item to the runner's buffer.
    cncserver.ipc.sendMessage('buffer.add', {
      hash: hash,
      commands: cncserver.buffer.render(item),
      duration: item.duration
    });

    cncserver.io.sendBufferAdd(item, hash); // Alert clients.
  };

  // Remove an object from the end of buffer (the only place they're removed).
  //
  // This should only be called by the process running the buffer, and denotes
  // when an item is run into the machine.
  cncserver.buffer.removeItem = function() {
    var hash = cncserver.buffer.data.pop();
    console.log('Removing Item hash:', hash);

    if (hash) {
      var item = cncserver.buffer.dataSet[hash];

      // Update the state of the actualPen to match the one in the buffer.
      cncserver.actualPen = extend({}, item.pen);

      // Trigger an update for actualPen change.
      cncserver.io.sendPenUpdate();

      // For buffer items with non-serial commands, it's time to do something!
      cncserver.buffer.trigger(item);

      delete cncserver.buffer.dataSet[hash];
      cncserver.io.sendBufferRemove();
    } else {
      console.error(
        'End IPC/Buffer Item & Hash Mismatch. This should never happen!'
      );
    }
  };

  /**
   * Helper function for clearing the buffer.
   */
  cncserver.buffer.clear = function() {
    cncserver.buffer.data = [];
    cncserver.buffer.dataSet = {};

    // Reset the state of the buffer tip pen to the state of the actual robot.
    // If this isn't done, it will be assumed to be a state that was deleted
    // and never sent out.
    cncserver.pen = extend({}, cncserver.actualPen);
    cncserver.ipc.sendMessage('buffer.clear');

    // Send full update as it's been cleared.
    cncserver.io.sendBufferComplete();
  };

  /**
   * Add a command to the command runner buffer.
   *
   * @param {string} command
   *   The command type to be run, must be one of the supported:
   *    - move
   *    - height
   *    - message
   *    - callbackname
   *    - wait
   *    - custom
   *    - callback
   * @param {object} data
   *   The data to be applied in the command.
   * @param {int} duration
   *   The time in milliseconds this command should take to run.
   *
   * @returns {boolean}
   *   Return false if failure, true if success
   */
  cncserver.run = function(command, data, duration) {
    var c = '';

    // Sanity check duration to minimum of 1, int only
    duration = !duration ? 1 : Math.abs(parseInt(duration));
    duration = duration <= 0 ? 1 : duration;

    switch (command) {
      case 'move':
        // Detailed buffer object X and Y.
        c = {type: 'absmove', x: data.x, y: data.y, source: data.source};
        break;
      case 'height':
        // Detailed buffer object with z height and state string
        c = {
          type: 'absheight',
          z: data.z,
          source: data.source,
          state: cncserver.pen.state
        };
        break;
      case 'message':
        // Detailed buffer object with a string message
        c = {type: 'message', message: data};
        break;
      case 'callbackname':
        // Detailed buffer object with a callback machine name
        c = {type: 'callbackname', name: data};
        break;
      case 'wait':
        // Send wait, blocking buffer
        if (!cncserver.bot.commands.wait) return false;
        c = cncserver.buffer.cmdstr('wait', {d: duration});
        break;
      case 'custom':
        c = data;
        break;
      case 'callback': // Custom callback runner for API return triggering
        c = data;
        break;
      default:
        return false;
    }

    // Add final command and duration to end of queue, along with a copy of the
    // pen state at this point in time to be copied to actualPen after execution
    cncserver.buffer.addItem({
      command: c,
      duration: duration,
      pen: extend({}, cncserver.pen)
    });

    return true;
  };



  /**
   * Render an item into a psudo serial command "string".
   *
   * The command will either be a direct string if direct and without dynamic
   * vars, or it will be an object. TODO: Make Dynamic vars work
   * @param  {object} item
   *   The raw buffer item.
   *
   * @return {array}
   *   Array of all serial command strings rendered from buffer item.
   */
  cncserver.buffer.render = function(item) {
    var commandOut = "";

    if (typeof item.command === "object") { // Detailed buffer object
      switch (item.command.type) {
        case 'absmove':
          var change = cncserver.utils.getPosChangeData(
            item.command.source,
            item.command
          );
          commandOut = [cncserver.buffer.cmdstr('movexy', change)];
          break;
        case 'absheight':
          //cncserver.control.actuallyMoveHeight(, item.command.state);
          var hChange = cncserver.utils.getHeightChangeData(
            item.command.source,
            item.command.z
          );
          commandOut = [cncserver.buffer.cmdstr('movez', {z: item.command.z})];

          // If there's a togglez, run it after setting Z
          if (cncserver.bot.commands.togglez) {
            commandOut.push(
              cncserver.buffer.cmdstr(
                'togglez',
                {t: cncserver.gConf.get('flipZToggleBit') ? 1 : 0}
              )
            );
          }

          commandOut.push(cncserver.buffer.cmdstr('wait', {d: hChange.d}));
          break;
      }
    } else {
      // Serial command is direct string in item.command, no render needed.
      commandOut = [item.command];
    }

    return commandOut;
  };

  /**
   * Trigger non-serial commands in buffer items (if any).
   *
   * @param  {object} item
   *   Buffer item to check/trigger.
   *
   * @return {boolean}
   *   True if triggered, false if not applicable.
   */
  cncserver.buffer.trigger = function(item) {
    if (typeof item.command === "function") { // Custom Callback buffer item
      // Just call the callback function.
      item.command(1);
      return true;
    } else if (typeof item.command === "object") { // Detailed buffer object
      switch (item.command.type) {
        case 'message':
          cncserver.io.sendMessageUpdate(item.command.message);
          return true;
        case 'callbackname':
          cncserver.io.sendCallbackUpdate(item.command.name);
          return true;
      }
    }

    return false;
  };

  /**
   * Create a bot specific serial command string from a key:value object
   *
   * @param {string} name
   *   Key in cncserver.bot.commands object to find the command string
   * @param {object} values
   *   Object containing the keys of placeholders to find in command string,
   *   with value to replace placeholder.
   *
   * @returns {string}
   *   Serial command string intended to be outputted directly, empty string
   *   if error.
   */
  cncserver.buffer.cmdstr = function(name, values) {
    if (!name || !cncserver.bot.commands[name]) return ''; // Sanity check

    var out = cncserver.bot.commands[name];

    for(var v in values) {
      out = out.replace('%' + v, values[v]);
    }

    return out;
  };

};
