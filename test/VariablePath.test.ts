import { ModelManager } from '@accordproject/concerto-core';
import { TemplateMarkTransformer } from '@accordproject/markdown-template';
import jp from 'jsonpath';
import { TemplateMarkInterpreter } from '../src';

interface DraftedVariable {
    name: string;
    value: string;
    path: string;
}

const MODEL = `namespace test@1.0.0
concept Signature { o String walletAddress }
concept Party {
  o String partyId
  o Signature signature optional
}
@template
concept TemplateData {
  o Party licensee
  o String licenseeState
  o Party licensor
  o String licensorState
  o Party[] parties
  o String[] colors
  o Integer age optional
}`;

const DATA = {
    $class: 'test@1.0.0.TemplateData',
    licensee: { $class: 'test@1.0.0.Party', partyId: 'Me', signature: { $class: 'test@1.0.0.Signature', walletAddress: '0xabc' } },
    licenseeState: 'NY',
    licensor: { $class: 'test@1.0.0.Party', partyId: 'You' },
    licensorState: 'CA',
    parties: [
        { $class: 'test@1.0.0.Party', partyId: 'P1' },
        { $class: 'test@1.0.0.Party', partyId: 'P2', signature: { $class: 'test@1.0.0.Signature', walletAddress: '0xdef' } },
    ],
    colors: ['red', 'blue'],
    age: 42,
};

/**
 * Collects the name, value and path of every Variable in an AgreementMark document.
 * @param {unknown} node the AgreementMark JSON
 * @param {DraftedVariable[]} out the accumulated variables
 * @returns {DraftedVariable[]} the variables, in document order
 */
function variables(node: unknown, out: DraftedVariable[] = []): DraftedVariable[] {
    if (Array.isArray(node)) {
        node.forEach((child) => variables(child, out));
    }
    else if (node && typeof node === 'object') {
        const record = node as Record<string, unknown>;
        if (typeof record.$class === 'string' && /Variable$/.test(record.$class)) {
            out.push({ name: record.name as string, value: record.value as string, path: record.path as string });
        }
        Object.keys(record).forEach((key) => variables(record[key], out));
    }
    return out;
}

async function generate(template: string): Promise<DraftedVariable[]> {
    const modelManager = new ModelManager();
    modelManager.addCTOModel(MODEL);
    const templateMark = new TemplateMarkTransformer().fromMarkdownTemplate({ content: template }, modelManager, 'contract', { verbose: false });
    const agreementMark = await new TemplateMarkInterpreter(modelManager, {}).generate(templateMark, DATA, { now: '2023-03-17T00:00:00.000Z' });
    return variables(agreementMark.toJSON());
}

describe('variable path', () => {
    test('variables that share a name under different parents get distinct paths (#371)', async () => {
        const result = await generate('{{#with licensee}}{{partyId}}{{/with}} ({{licenseeState}}) and {{#with licensor}}{{partyId}}{{/with}} ({{licensorState}})');
        expect(result).toEqual([
            { name: 'partyId', value: 'Me', path: '$[\'licensee\'][\'partyId\']' },
            { name: 'licenseeState', value: 'NY', path: '$[\'licenseeState\']' },
            { name: 'partyId', value: 'You', path: '$[\'licensor\'][\'partyId\']' },
            { name: 'licensorState', value: 'CA', path: '$[\'licensorState\']' },
        ]);
    });

    test('list items carry their index', async () => {
        const result = await generate('{{#ulist parties}}\n- {{partyId}}\n{{/ulist}}');
        expect(result).toEqual([
            { name: 'partyId', value: 'P1', path: '$[\'parties\'][0][\'partyId\']' },
            { name: 'partyId', value: 'P2', path: '$[\'parties\'][1][\'partyId\']' },
        ]);
    });

    test('a list of primitives points at each item', async () => {
        const result = await generate('{{#ulist colors}}\n- {{this}}\n{{/ulist}}');
        expect(result.map((v) => v.path)).toEqual(['$[\'colors\'][0]', '$[\'colors\'][1]']);
    });

    test('variables inside an object optional include the optional property', async () => {
        const result = await generate('{{#with licensee}}{{#optional signature}}{{walletAddress}}{{else}}unsigned{{/optional}}{{/with}}');
        expect(result).toEqual([
            { name: 'walletAddress', value: '0xabc', path: '$[\'licensee\'][\'signature\'][\'walletAddress\']' },
        ]);
    });

    test('an optional inside a list keeps the item index', async () => {
        const result = await generate('{{#ulist parties}}\n- {{#optional signature}}{{walletAddress}}{{else}}unsigned{{/optional}}\n{{/ulist}}');
        expect(result).toEqual([
            { name: 'walletAddress', value: '0xdef', path: '$[\'parties\'][1][\'signature\'][\'walletAddress\']' },
        ]);
    });

    test('{{this}} in a scalar optional points at the optional value', async () => {
        const result = await generate('{{#optional age}}You are {{this}} years old{{/optional}}');
        expect(result).toEqual([{ name: 'this', value: '42', path: '$[\'age\']' }]);
    });

    test('every path resolves to the drafted value in the template data', async () => {
        const result = await generate('{{#with licensee}}{{partyId}}{{/with}} {{#with licensor}}{{partyId}}{{/with}} \n\n{{#ulist parties}}\n- {{partyId}}\n{{/ulist}}\n\n{{#ulist colors}}\n- {{this}}\n{{/ulist}}');
        for (const variable of result) {
            expect(String(jp.value(DATA, variable.path))).toBe(variable.value);
        }
    });
});
