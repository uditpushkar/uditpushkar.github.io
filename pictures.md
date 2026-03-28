---
layout: pictures
title: Pictures
permalink: /pictures/
sub_title: "Cloudinary albums in an Instagram-style masonry feed"
introduction: |
  This gallery is generated from Cloudinary album folders and laid out in a responsive masonry feed.
---

{% assign albums = site.data.cloudinary_gallery.albums | default: site.data.pictures.albums | default: empty %}

{% if albums.size > 0 %}
  {% if albums.size > 1 %}
    <div class="pictures-toolbar">
      <button class="picture-filter is-active" type="button" data-filter="all">All</button>
      {% for album in albums %}
        {% assign display_title = album.title | default: album.slug | replace: '-', ' ' | replace: '_', ' ' %}
        <button class="picture-filter" type="button" data-filter="{{ album.slug }}">{{ display_title }}</button>
      {% endfor %}
    </div>
  {% endif %}

  <div class="picture-feed">
    <div class="grid-sizer"></div>
    {% for album in albums %}
      {% for image in album.images %}
        {% assign display_title = album.title | default: album.slug | replace: '-', ' ' | replace: '_', ' ' %}
        <article class="picture-card" data-album="{{ album.slug }}">
          <a class="picture-link" href="{{ image.full | default: image.src }}" target="_blank" rel="noopener noreferrer">
            <img
              src="{{ image.src }}"
              alt="{{ image.alt | default: display_title | escape }}"
              loading="lazy"
              {% if image.width %}width="{{ image.width }}"{% endif %}
              {% if image.height %}height="{{ image.height }}"{% endif %}>
          </a>
        </article>
      {% endfor %}
    {% endfor %}
  </div>
{% else %}
  <div class="pictures-empty">
    <p>No pictures have been synced yet.</p>
    <p>Run the local Cloudinary sync script or the GitHub Action to generate the gallery feed.</p>
  </div>
{% endif %}
