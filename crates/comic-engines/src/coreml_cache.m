#import "coreml_cache.h"

static NSString *comic_coreml_cache_dir(void) {
    NSArray<NSString *> *roots =
        NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
    NSString *root = roots.firstObject;
    if (root.length == 0) {
        root = NSTemporaryDirectory();
    }
    NSString *dir = [root stringByAppendingPathComponent:@"app.comic.enhance/coreml"];
    NSError *err = nil;
    if (![[NSFileManager defaultManager] createDirectoryAtPath:dir
                                   withIntermediateDirectories:YES
                                                    attributes:nil
                                                         error:&err]) {
        NSLog(@"PureComic: Core ML cache dir %@ : %@", dir, err);
    }
    return dir;
}

NSURL *comic_coreml_cache_destination(NSString *legacyPath, NSString *cacheLeaf, BOOL *ready) {
    NSFileManager *fm = [NSFileManager defaultManager];
    BOOL isDir = NO;
    if (legacyPath.length > 0 && [fm fileExistsAtPath:legacyPath isDirectory:&isDir] && isDir) {
        if (ready) {
            *ready = YES;
        }
        return [NSURL fileURLWithPath:legacyPath isDirectory:YES];
    }
    NSString *dest = [comic_coreml_cache_dir() stringByAppendingPathComponent:cacheLeaf];
    isDir = NO;
    if ([fm fileExistsAtPath:dest isDirectory:&isDir] && isDir) {
        if (ready) {
            *ready = YES;
        }
        return [NSURL fileURLWithPath:dest isDirectory:YES];
    }
    if (ready) {
        *ready = NO;
    }
    return [NSURL fileURLWithPath:dest isDirectory:YES];
}

BOOL comic_coreml_store_compiled(NSURL *tmp, NSURL *dest) {
    if (!tmp || !dest) {
        return NO;
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    [fm removeItemAtURL:dest error:nil];
    NSError *err = nil;
    if ([fm copyItemAtURL:tmp toURL:dest error:&err]) {
        return YES;
    }
    NSLog(@"PureComic: Core ML compile cache copy failed (%@): %@", dest.path, err);
    return NO;
}
