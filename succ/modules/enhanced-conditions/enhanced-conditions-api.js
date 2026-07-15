import * as BUTLER from "../butler.js";
import { Sidekick, TelemetryUtils } from "../sidekick.js";
import { EnhancedConditions } from "./enhanced-conditions.js";

/**
 * API functions for interacting with EnhancedConditions
 */
export class EnhancedConditionsAPI {

    /* -------------------------------------------- */
    /*                      API                     */
    /* -------------------------------------------- */

    /**
     * Applies the named condition to the provided entities (Actors or Tokens)
     * @param {String[] | String} conditionId  the id of the condition to add
     * @param {(Actor[] | Token[] | Actor | Token)} [entities=null] one or more Actors or Tokens to apply the Condition to
     * @param {Boolean} [options.allowDuplicates=false]  if one or more of the Conditions specified is already active on the Entity, this will still add the Condition. Use in conjunction with `replaceExisting` to determine how duplicates are handled
     * @param {Boolean} [options.forceOverlay=false]  if true, this condition will appear as an overlay regardless of its normal behaviour
     * @param {Boolean} [options.duration=undefined]  if set, this will override the duration on the effect
     * @param {Boolean} [options.effectOptions]  additional options that are added to a property to be used by elsewhere in the code
     * @example
     * //Add the Condition "Blinded" to an Actor named "Bob". Duplicates will not be created.
     * game.succ.addCondition("Blinded", game.actors.getName("Bob"));
     * @example
     * //Add the Condition "Charmed" to the currently controlled Token/s. Duplicates will not be created.
     * game.succ.addCondition("Charmed");
     * @example
     * //Add the Conditions "Blinded" and "Charmed" to the targeted Token/s and create duplicates
     * game.succ.addCondition(["Blinded", "Charmed"], [...game.user.targets], {allowDuplicates: true});
     */
    static async addCondition(conditionId, entities=null, {allowDuplicates=false, forceOverlay=false, duration=undefined, effectOptions={}, sendTelemetry=true}={}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.addCondition, {
                allowDuplicates,
                forceOverlay,
                duration,
                effectOptions,
            });
        }

        if (!entities) {
            //First check for any controlled tokens otherwise use the user's character
            if (canvas?.tokens?.controlled.length) entities = canvas.tokens.controlled;
            else if (game.user.character) entities = game.user.character;
        }

        if (!entities) {
            ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.AddCondition.Failed.NoToken"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.AddCondition.Failed.NoToken")}`);
            return;
        }

        entities = Sidekick.toArray(entities);

        const conditions = Sidekick.toArray(EnhancedConditions.lookupConditionById(conditionId));
        if (!conditions.length) {
            ui.notifications.error(`${game.i18n.localize("ENHANCED_CONDITIONS.AddCondition.Failed.NoCondition")} ${conditionId}`);
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.AddCondition.Failed.NoCondition")}`, conditionId);
            return;
        }

        let effects = EnhancedConditionsAPI.getActiveEffect(conditions, { sendTelemetry: false });
        if (!effects) {
            ui.notifications.error(`${game.i18n.localize("ENHANCED_CONDITIONS.AddCondition.Failed.NoEffect")} ${conditions}`);
            console.log(`SWADE Ultimate Condition Changer - Enhanced Condition | ${game.i18n.localize("ENHANCED_CONDITIONS.AddCondition.Failed.NoEffect")}`, conditions);
            return;
        }

        effects = EnhancedConditions._prepareActiveEffects(Sidekick.toArray(effects));

        let resultEffects = [];

        for (let entity of entities) {
            const actor = EnhancedConditionsAPI.getActorFromEntity(entity, { sendTelemetry: false });

            if (!actor) continue;

            for (const effect of effects) {
                if (forceOverlay) {
                    effect.flags.core ??= {};
                    effect.flags.core.overlay = true;
                }

                if (duration != undefined) {
                    effect.duration.rounds = duration;
                }

                if (Object.entries(effectOptions ?? {}).length) {
                    Sidekick.setModuleFlag(effect, BUTLER.FLAGS.enhancedConditions.effectOptions, effectOptions);
                }
            }

            const conditionIds = conditions.map(c => c.id);
            const hasDuplicates = EnhancedConditionsAPI.hasCondition(conditionIds, actor, { warn: false, sendTelemetry: false });
            const newEffects = [];
            const duplicateEffects = [];

            //If there are duplicate condition effects on the actor take extra steps
            if (hasDuplicates) {
                //Get the existing conditions on the actor
                const existingConditionEffects = Sidekick.toArray(EnhancedConditionsAPI.getConditionEffects(actor, { warn: false, sendTelemetry: false }));
                const existingConditionIds = new Set(existingConditionEffects.map(e => Sidekick.conditionId(e)));

                //Loop through the effects sorting them into either duplicate or new effects
                for (const effect of effects) {
                    const conditionId = Sidekick.conditionId(effect);
                    if (!existingConditionIds.has(conditionId)) {
                        newEffects.push(effect);
                    } else if (allowDuplicates) {
                        duplicateEffects.push(effect);
                    }
                }
            }

            if (hasDuplicates) {
                if (newEffects.length) {
                    const createdDocuments = await actor.createEmbeddedDocuments("ActiveEffect", newEffects, { keepId: true });
                    resultEffects.push(...createdDocuments);
                }

                if (duplicateEffects.length) {
                    //We create duplicate effects with keepId: false otherwise they Foundry will reject them
                    const createdDocuments = await actor.createEmbeddedDocuments("ActiveEffect", duplicateEffects, { keepId: false });
                    resultEffects.push(...createdDocuments);
                }
            } else {
                const createdDocuments = await actor.createEmbeddedDocuments("ActiveEffect", effects, { keepId: true });
                resultEffects.push(...createdDocuments);
            }
        }

        return resultEffects;
    }

    /**
     * Removes one or more named conditions from an Entity (Actor/Token)
     * @param {String} conditionId  the id of the Condition to remove
     * @param {Actor | Token} entities  One or more Actors or Tokens
     * @param {Boolean} options.warn  whether or not to raise warnings on errors
     * @example
     * //Remove Condition named "Blinded" from an Actor named Bob
     * game.succ.removeCondition("Blinded", game.actors.getName("Bob"));
     * @example
     * //Remove Condition named "Charmed" from the currently controlled Token, but don't show any warnings if it fails.
     * game.succ.removeCondition("Charmed", {warn=false});
     */
    static async removeCondition(conditionId, entities=null, {warn=false, sendTelemetry=true}={}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.removeCondition);
        }

        if (!entities) {
            //First check for any controlled tokens otherwise use the user's character
            if (canvas?.tokens?.controlled.length) entities = canvas.tokens.controlled;
            else if (game.user.character) entities = game.user.character;

            if (!entities) {
                if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.RemoveCondition.Failed.NoToken"));
                console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.RemoveCondition.Failed.NoToken")}`);
                return;
            }
        }

        entities = Sidekick.toArray(entities);
        conditionId = Sidekick.toArray(conditionId);

        const conditions = Sidekick.toArray(EnhancedConditions.lookupConditionById(conditionId));
        if (!conditions.length) {
            if (warn) ui.notifications.error(`${game.i18n.localize("ENHANCED_CONDITIONS.RemoveCondition.Failed.NoCondition")} ${conditionId}`);
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.RemoveCondition.Failed.NoCondition")}`, conditionId);
            return;
        }

        const effects = Sidekick.toArray(EnhancedConditionsAPI.getActiveEffect(conditions, { sendTelemetry: false }));
        if (!effects.length) {
            if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDTIONS.RemoveCondition.Failed.NoEffect"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Condition | ${game.i18n.localize("ENHANCED_CONDTIONS.RemoveCondition.Failed.NoEffect")}`, condition);
            return;
        }

        for (const entity of entities) {
            const actor = EnhancedConditionsAPI.getActorFromEntity(entity, { sendTelemetry: false });
            const conditionIds = new Set(effects.map(e => Sidekick.conditionId(e)));
            const activeEffects = actor.effects.contents.filter(e => conditionIds.has(Sidekick.conditionId(e)));

            if (!activeEffects?.length) {
                if (warn) ui.notifications.warn(`${conditionId} ${game.i18n.localize("ENHANCED_CONDITIONS.RemoveCondition.Failed.NotActive")}`);
                console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${conditionId} ${game.i18n.localize("ENHANCED_CONDITIONS.RemoveCondition.Failed.NotActive")}")`);
                continue;
            }

            const effectIds = activeEffects.map(e => e.id);
            await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds);
        }
    }

    /**
     * Removes all conditions from the provided entities
     * @param {Actors | Tokens} entities  One or more Actors or Tokens to remove Conditions from
     * @param {Boolean} options.warn  output notifications
     * @example
     * //Remove all Conditions on an Actor named Bob
     * game.succ.removeAllConditions(game.actors.getName("Bob"));
     * @example
     * //Remove all Conditions on the currently controlled Token
     * game.succ.removeAllConditions();
     */
    static async removeAllConditions(entities=null, {warn=true, conditionsToKeep=[], sendTelemetry=true}={}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.removeAllConditions);
        }

        if (!entities) {
            //First check for any controlled tokens
            if (canvas?.tokens?.controlled.length) entities = canvas.tokens.controlled;
            else if (game.user.character) entities = game.user.character;
        }

        if (!entities) {
            if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.RemoveCondition.Failed.NoToken"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.RemoveCondition.Failed.NoToken")}`);
            return;
        }

        entities = Sidekick.toArray(entities);
        conditionsToKeep = new Set(conditionsToKeep);

        for (const entity of entities) {
            const actor = EnhancedConditionsAPI.getActorFromEntity(entity, { sendTelemetry: false });

            const actorConditionEffects = Sidekick.toArray(EnhancedConditionsAPI.getConditionEffects(actor, { warn: false, sendTelemetry: false }));
            if (!actorConditionEffects.length) continue;

            const effectIds = actorConditionEffects.filter(ace => !conditionsToKeep.has(Sidekick.conditionId(ace))).map(ace => ace.id);
            if (!effectIds.length) continue;

            await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds);
        }
    }

    /**
     * Apply the named condition to the provided entities (Actors or Tokens)
     * @param {*} conditionId the id of the Condition to find
     * @param {(Actor[] | Token[] | Actor | Token)} [entities=null] one or more Actors or Tokens to apply the Condition to
     * @param {Boolean} finalState true if we want to end up with the condition added, false if removed. If undefined, we toggle between added and removed
     * @param {Object} [options]  options object
     * @see EnhancedConditions#addCondition
     * @see EnhancedConditions#removeCondition
     */
    static async toggleCondition(conditionId, entities = null, finalState, options = {}, { sendTelemetry = true } = {}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.toggleCondition, {
                finalState,
                options,
            });
        }

        if (typeof finalState === 'undefined') {
            let currentState = EnhancedConditionsAPI.hasCondition(conditionId, entities, { sendTelemetry: false });
            finalState = !currentState;
        }
        if (finalState) {
            return await EnhancedConditionsAPI.addCondition(conditionId, entities, { ...options, sendTelemetry: false });
        } else {
            return await EnhancedConditionsAPI.removeCondition(conditionId, entities, { sendTelemetry: false });
        }
    }

    /**
     * Gets a condition by id from the Condition Map
     * @param {*} conditionId the id of the Condition to find
     * @param {*} map the map to search through. If null, we'll use the current map
     * @param {*} options.warn whether or not to raise warnings on errors
     */
    static getCondition(conditionId, map = null, { warn = false, sendTelemetry = true } = {}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.getCondition);
        }

        if (!conditionId) {
            if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.GetCondition.Failed.NoCondition"));
        }

        if (!map) map = Sidekick.getSetting(BUTLER.SETTING_KEYS.enhancedConditions.map);

        return EnhancedConditions.lookupConditionById(conditionId, map);
    }

    /**
     * Gets a condition by id from given Actor or String
     * @param {*} conditionId the id of the Condition to find
     * @param {Actor | String | Object} entity the Actor or Token to get the condition from
     * @param {*} options.warn whether or not to raise warnings on errors
     */
    static getConditionFrom(conditionId, entity, { warn = false, sendTelemetry = true } = {}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.getConditionFrom);
        }

        if (!conditionId) {
            if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.GetCondition.Failed.NoCondition"));
        }
        if (!entity) {
            ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.AddCondition.Failed.NoToken"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.AddCondition.Failed.NoToken")}`);
            return;
        }

        const actor = EnhancedConditionsAPI.getActorFromEntity(entity, { sendTelemetry: false });

        if (!actor) {
            return;
        }

        let conditions = EnhancedConditions.lookupConditionById(conditionId);

        if (!conditions) {
            if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.HasCondition.Failed.NoMapping"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.RemoveCondition.Failed.NoMapping")}`);
            return;
        }

        conditions = Sidekick.toArray(EnhancedConditions._prepareStatusEffects(conditions));

        const conditionEffect = actor.effects.contents.find(ae => {
            const aeId = Sidekick.conditionId(ae);
            return aeId !== undefined && conditions.find(e => Sidekick.conditionId(e) === aeId);
        });

        return conditionEffect;
    }

    /**
     * Retrieves all active conditions for one or more given entities (Actors or Tokens)
     * @param {Actor | Token} entities  one or more Actors or Tokens to get Conditions from
     * @param {Boolean} options.warn  whether or not to raise warnings on errors
     * @returns {Array} entityConditionMap  a mapping of conditions for each provided entity
     * @example
     * //Get conditions for an Actor named "Bob"
     * game.succ.getConditions(game.actors.getName("Bob"));
     * @example
     * //Get conditions for the currently controlled Token
     * game.succ.getConditions();
     */
    static getConditions(entities = null, { warn = true, sendTelemetry = true } = {}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.getConditions);
        }

        if (!entities) {
            //First check for any controlled tokens
            if (canvas?.tokens?.controlled.length) entities = canvas.tokens.controlled;

            //Then check if the user has an assigned character
            else if (game.user.character) entities = game.user.character;
        }


        if (!entities) {
            if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.GetConditions.Failed.NoToken"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.GetConditions.Failed.NoToken")}`);
            return;
        }

        const map = Sidekick.getSetting(BUTLER.SETTING_KEYS.enhancedConditions.map);

        if (!map || !map.length) {
            if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.GetConditions.Failed.NoCondition"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.GetConditions.Failed.NoCondition")}`);
            return;
        }

        entities = Sidekick.toArray(entities);

        const results = [];

        for (const entity of entities) {
            const actor = EnhancedConditionsAPI.getActorFromEntity(entity, { sendTelemetry: false });
            const effects = Sidekick.toArray(actor?.effects.contents);
            if (!effects.length) continue;

            const effectIds = effects.filter(e => Sidekick.conditionId(e)).map(e => Sidekick.conditionId(e));
            if (!effectIds.length) continue;

            const entityConditions = {
                entity: entity,
                conditions: EnhancedConditions.lookupEntryMapping(effectIds)
            };

            results.push(entityConditions);
        }

        if (!results.length) {
            if (warn) ui.notifications.notify(game.i18n.localize("ENHANCED_CONDITIONS.GetConditions.Failed.NoResults"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.GetConditions.Failed.NoResults")}`);
            return null;
        }

        return results.length > 1 ? results : results.shift();
    }

    /**
     * Gets the Active Effect data (if any) for the given condition
     * @param {*} condition the id of the Condition to get
     */
    static getActiveEffect(condition, { sendTelemetry = true } = {}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.getActiveEffect);
        }

        return EnhancedConditions._prepareStatusEffects(condition);
    }

    /**
     * Gets any Active Effect instances present on the entities (Actor/s or Token/s) that are mapped Conditions
     * @param {String} entities  the entities to check
     * @param {Array} map  the Condition map to check (optional)
     * @param {Boolean} warn  whether or not to raise warnings on errors
     * @returns {Map | Object} A Map containing the Actor Id and the Condition Active Effect instances if any
     */
    static getConditionEffects(entities, map = null, { warn = true, sendTelemetry = true } = {}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.getConditionEffects);
        }

        if (!entities) {
            //First check for any controlled tokens
            if (canvas?.tokens?.controlled.length) entities = canvas.tokens.controlled;
            else if (game.user.character) entities = game.user.character;
        }

        if (!entities) {
            if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.GetConditionEffects.Failed.NoEntity"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.RemoveCondition.Failed.NoToken")}`);
            return;
        }

        entities = Sidekick.toArray(entities);

        if (!map) map = Sidekick.getSetting(BUTLER.SETTING_KEYS.enhancedConditions.map);

        let results = new Collection();

        for (const entity of entities) {
            const actor = EnhancedConditionsAPI.getActorFromEntity(entity, { sendTelemetry: false });
            const activeEffects = actor.effects.contents;

            if (!activeEffects.length) continue;

            const conditionEffects = activeEffects.filter(ae => Sidekick.conditionId(ae));

            if (!conditionEffects.length) continue;

            results.set(entity.id, conditionEffects.length > 1 ? conditionEffects : conditionEffects.shift());
        }

        if (!results.size) return null;

        return results.size > 1 ? results : results.values().next().value;
    }

    /**
     * Checks if the provided Entity (Actor or Token) has the given condition
     * @param {String | Array} conditionId  the id/s of the condition or conditions to check for
     * @param {Actor | Token | Array} entities  the entity or entities to check (Actor/s or Token/s)
     * @param {Object} [options]  options object
     * @param {Boolean} [options.warn]  whether or not to output notifications
     * @returns {Boolean} hasCondition  Returns true if one or more of the provided entities has one or more of the provided conditions
     * @example
     * //Check for the "Blinded" condition on Actor "Bob"
     * game.succ.hasCondition("Blinded", game.actors.getName("Bob"));
     * @example
     * //Check for the "Charmed" and "Deafened" conditions on the controlled tokens
     * game.succ.hasCondition(["Charmed", "Deafened"]);
     */
    static hasCondition(conditionId, entities = null, { warn = true, sendTelemetry = true } = {}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.hasCondition);
        }

        if (!conditionId) {
            if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.HasCondition.Failed.NoCondition"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.HasCondition.Failed.NoCondition")}`);
            return false;
        }

        if (!entities) {
            //First check for any controlled tokens
            if (canvas?.tokens?.controlled.length) entities = canvas.tokens.controlled;

            //Then check if the user has an assigned character
            else if (game.user.character) entities = game.user.character;
        }

        if (!entities) {
            if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.HasCondition.Failed.NoToken"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.HasCondition.Failed.NoToken")}`);
            return false;
        }

        entities = Sidekick.toArray(entities);

        let conditions = EnhancedConditions.lookupConditionById(conditionId);

        if (!conditions) {
            if (warn) ui.notifications.error(game.i18n.localize("ENHANCED_CONDITIONS.HasCondition.Failed.NoMapping"));
            console.log(`SWADE Ultimate Condition Changer - Enhanced Conditions | ${game.i18n.localize("ENHANCED_CONDITIONS.RemoveCondition.Failed.NoMapping")}`);
            return false;
        }

        conditions = Sidekick.toArray(EnhancedConditions._prepareStatusEffects(conditions));

        for (const entity of entities) {
            const actor = EnhancedConditionsAPI.getActorFromEntity(entity, { sendTelemetry: false });

            if (!actor.effects.size) continue;

            const hasCondition = actor.effects.contents.some(ae => {
                const aeId = Sidekick.conditionId(ae);
                return aeId !== undefined && conditions.some(e => Sidekick.conditionId(e) === aeId);
            });

            if (hasCondition) return true;
        }

        return false;
    }

    /**
     * Converts the provided entity into an Actor
     * @param {Actor | Token | TokenDocument | String} entity  The entity to convert
     * @returns {Actor} Returns the converted Actor or null if none was found
     */
    static getActorFromEntity(entity, { sendTelemetry = true } = {}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.hasCondition);
        }

        return entity instanceof Actor ? entity : entity instanceof foundry.canvas.placeables.Token || entity instanceof TokenDocument ? entity.actor : null;
    }

    /**
     * @param sceneId The scene ID on which the function looks for token actors to remove the conditions from; defaults to current scene.
     * @param confirmed Boolean to skip the confirmation dialogue.
     */
    static async removeTemporaryEffects(sceneId = false, confirmed = false, { sendTelemetry = true } = {}) {
        if (sendTelemetry) {
            TelemetryUtils.sendAPITelemetry(EnhancedConditionsAPI.removeTemporaryEffects);
        }

        const scene = sceneId ? game.scenes.get(sceneId) : game.scenes.current;
        if (confirmed) {
            executeRemoval();
        } else {
            foundry.applications.api.DialogV2.confirm({
                window: { title: "ENHANCED_CONDITIONS.Dialog.RemoveTemporaryEffects.Name" },
                content: game.i18n.format("ENHANCED_CONDITIONS.Dialog.RemoveTemporaryEffects.Body", { sceneName: `${scene.navName} (${scene.name})` }),
                yes: {
                    callback: () => {
                        executeRemoval();
                    }
                },
            });
        }

        async function executeRemoval() {
            const sceneTokens = scene.tokens;
            const nonCombatTokens = sceneTokens.filter(t => t.inCombat === false);
            if (!nonCombatTokens) {
                return;
            }
            for (let token of nonCombatTokens) {
                const actor = token.actor;
                const tokenEffects = actor.effects;
                const durationEffects = tokenEffects.filter(e => typeof e.duration.rounds === "number" && !isNaN(e.duration.rounds) && isFinite(e.duration.rounds));
                let effectsToDeleteIds = [];
                for (let effect of durationEffects) {
                    effectsToDeleteIds.push(effect.id);
                }
                if (durationEffects) {
                    await actor.deleteEmbeddedDocuments('ActiveEffect', effectsToDeleteIds);
                }
            }
        }
    }
}