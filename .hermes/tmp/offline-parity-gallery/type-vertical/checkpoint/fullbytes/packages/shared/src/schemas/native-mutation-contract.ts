// Shared source for foreground requirements and generated native current-kind contract.
export const nativeMutationContract = {
  "gallery.order.set": { "entityKind": "gallery_order", "flags": ["offlineMutations", "offlineGalleryOrder"] },
  "entry.delete": { "entityKind": "entry", "flags": ["offlineMutations", "offlineEntryDelete"] },
  "entry.update": {
    "entityKind": "entry",
    "flags": [
      "offlineMutations",
      "offlineEntryUpdate"
    ]
  },
  "entry.create": {
    "entityKind": "entry",
    "flags": [
      "offlineMutations",
      "offlineEntryCreate"
    ]
  },
  "entry.content.append": {
    "entityKind": "entry",
    "flags": [
      "offlineMutations",
      "offlineEntryContentAppend"
    ]
  },
  "entry.usage": {
    "entityKind": "entry",
    "flags": [
      "offlineMutations",
      "offlineUsageEvents"
    ]
  },
  "entry.view-later.set": {
    "entityKind": "entry",
    "flags": [
      "offlineMutations",
      "offlineEntryViewLater"
    ]
  },
  "entry.rating.set": {
    "entityKind": "entry",
    "flags": [
      "offlineMutations",
      "offlineEntryRating"
    ]
  },
  "entry.authors.set": {
    "entityKind": "entry",
    "flags": [
      "offlineMutations",
      "offlineEntryAuthors"
    ]
  },
  "entry.author.create-and-link": {
    "entityKind": "entry",
    "flags": [
      "offlineMutations",
      "offlineAuthorCreate"
    ]
  },
  "entry.tag.create": {
    "entityKind": "entry_tag",
    "flags": [
      "offlineMutations",
      "offlineEntryTagVocabulary"
    ]
  },
  "entry.facet.create": {
    "entityKind": "entry_facet",
    "flags": [
      "offlineMutations",
      "offlineEntryFacetCreate"
    ]
  },
  "entry.tags.set": {
    "entityKind": "entry",
    "flags": [
      "offlineMutations",
      "offlineEntryTags"
    ]
  },
  "entry.contents.set": {
    "entityKind": "entry",
    "flags": [
      "offlineMutations",
      "offlineEntryContents"
    ]
  },
  "producer.view-later.set": {
    "entityKind": "producer",
    "flags": [
      "offlineMutations",
      "offlineProducerViewLater"
    ]
  },
  "producer.rating.set": {
    "entityKind": "producer",
    "flags": [
      "offlineMutations",
      "offlineProducerRating"
    ]
  },
  "producer.delete": { "entityKind": "producer", "flags": ["offlineMutations", "offlineAuthorDelete"] },
  "producer.create": { "entityKind": "producer", "flags": ["offlineMutations", "offlineStandaloneAuthorCreate"], "fieldFlags": {"directorySetUid":"offlineStandaloneAuthorDirectorySeed"} },
  "producer.update": {
    "entityKind": "producer",
    "flags": [
      "offlineMutations",
      "offlineProducerProfile"
    ]
  },
  "producer.tags.set": {
    "entityKind": "producer",
    "flags": [
      "offlineMutations",
      "offlineProducerTags"
    ]
  },
  "rating-layout.slots.set": {
    "entityKind": "rating_layout",
    "flags": [
      "offlineMutations",
      "offlineRatingSlotLayout"
    ]
  },
  "author.directories.set": {
    "entityKind": "author_directory_set",
    "flags": [
      "offlineMutations",
      "offlineAuthorDirectories"
    ]
  },
  "collection.create": {
    "entityKind": "collection",
    "flags": [
      "offlineMutations",
      "offlineCollectionManagement"
    ]
  },
  "collection.entry.set": {
    "entityKind": "collection",
    "flags": [
      "offlineMutations",
      "offlineCollectionManagement"
    ]
  },
  "collection.order.set": {
    "entityKind": "collection_order",
    "flags": [
      "offlineMutations",
      "offlineCollectionManagement"
    ]
  },
  "collection.producer.set": {
    "entityKind": "collection",
    "flags": [
      "offlineMutations",
      "offlineCollectionProducerMembership"
    ]
  },
  "collection.common-tag.add": {"entityKind":"collection","flags":["offlineMutations","offlineCollectionManagement","offlineCollectionCommonTag"]},
  "collection.delete": {"entityKind":"collection","flags":["offlineMutations","offlineCollectionManagement","offlineCollectionDelete"]},
  "collection.update": {
    "entityKind": "collection",
    "flags": [
      "offlineMutations",
      "offlineCollectionManagement"
    ]
  }
} as const;
