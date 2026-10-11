import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaTransformation from "effect/SchemaTransformation";

// JSON has no undefined. Keep explicit undefined valid for in-process callers,
// while publishing the same null branch as Schema.optional's JSON codec.
const optionalEmpty = Schema.declare<null | undefined>(
  (value): value is null | undefined => value === null || value === undefined,
  {
    toCodecJson: () =>
      Schema.link<null | undefined>()(
        Schema.Null,
        SchemaTransformation.transform<null | undefined, null>({
          decode: () => null,
          encode: () => null,
        }),
      ),
  },
);
const omittedNull = optionalEmpty.pipe(
  Schema.decodeTo(
    Schema.Undefined,
    SchemaTransformation.transformOptional<undefined, null | undefined>({
      decode: (value) => Option.filter(value, (value): value is undefined => value !== null),
      encode: (value) => value,
    }),
  ),
).ast;

/**
 * Accept the null already advertised for optional MCP parameters as omission.
 * Derive an input-only schema so shared result and non-MCP contracts stay intact.
 */
export const mcpInput = <S extends Schema.Constraint>(schema: S) => {
  const cache = new Map<SchemaAST.AST, SchemaAST.AST>();
  const visit = (ast: SchemaAST.AST): SchemaAST.AST => {
    const cached = cache.get(ast);
    if (cached) return cached;
    const link = (link: SchemaAST.Link) => new SchemaAST.Link(visit(link.to), link.transformation);
    const encoding: SchemaAST.Encoding | undefined = ast.encoding
      ? [link(ast.encoding[0]), ...ast.encoding.slice(1).map(link)]
      : undefined;
    let result = ast;
    switch (ast._tag) {
      case "Objects":
        result = new SchemaAST.Objects(
          ast.propertySignatures.map((p) => new SchemaAST.PropertySignature(p.name, visit(p.type))),
          ast.indexSignatures.map((p) => new SchemaAST.IndexSignature(p.parameter, visit(p.type))),
          ast.annotations,
          ast.checks,
          encoding,
          ast.context,
          ast.encodingChecks,
        );
        break;
      case "Arrays":
        result = new SchemaAST.Arrays(
          ast.isMutable,
          ast.elements.map(visit),
          ast.rest.map(visit),
          ast.annotations,
          ast.checks,
          encoding,
          ast.context,
          ast.encodingChecks,
        );
        break;
      case "Union": {
        const encodedSchema = Schema.toEncoded(Schema.make(ast));
        const isEncoded = Schema.is(encodedSchema);
        const optional = SchemaAST.isOptional(ast) && !isEncoded(null);
        // Replace only the undefined branch of Schema.optional(X). This is
        // optional(NullOr(X)) with a missing-key transform, without duplicating
        // null branches in the published JSON schema. Explicit NullOr stays null.
        result = new SchemaAST.Union(
          ast.types.map((member) =>
            optional && member._tag === "Undefined" ? omittedNull : visit(member),
          ),
          ast.options,
          ast.annotations,
          ast.checks,
          encoding,
          ast.context,
          ast.encodingChecks,
        );
        break;
      }
      case "Suspend":
        result = new SchemaAST.Suspend(
          () => visit(ast.thunk()),
          ast.annotations,
          ast.checks,
          encoding,
          ast.context,
        );
        break;
    }
    cache.set(ast, result);
    return result;
  };
  return Schema.make<
    Schema.Codec<S["Type"], unknown, S["DecodingServices"], S["EncodingServices"]>
  >(visit(schema.ast));
};
