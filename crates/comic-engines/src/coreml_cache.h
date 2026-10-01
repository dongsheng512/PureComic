#import <Foundation/Foundation.h>

/// Writable compiled-model URL. An existing legacy sibling is reused so dev
/// trees do not recompile. Otherwise the destination is under
/// ~/Library/Caches/app.comic.enhance/coreml, which stays writable inside a
/// signed app bundle. *ready is YES when that URL already contains a model.
NSURL *comic_coreml_cache_destination(NSString *legacyPath, NSString *cacheLeaf, BOOL *ready);

/// Copy a Core ML compile result into dest. Logs and returns NO on failure;
/// the caller keeps the temporary compile.
BOOL comic_coreml_store_compiled(NSURL *tmp, NSURL *dest);
